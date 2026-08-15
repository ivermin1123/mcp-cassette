#!/usr/bin/env bash
#
# End-to-end smoke test: dogfood the mcp-cassette CLI against the official
# MCP reference server (@modelcontextprotocol/server-everything).
#
# Exercises the full product loop:
#   1. check    a live server
#   2. record   a session by driving the record proxy with check
#   3. check    the replayed cassette (no network, no real server)
#   4. snapshot the replayed contract
#   5. snapshot --check the same replay -> must report no drift
#
# Every step must exit 0; `set -e` fails the run otherwise.
#
# Usage:
#   npm run build && ./scripts/smoke.sh
#
#   # pick a different reference-server version:
#   SERVER_PKG='@modelcontextprotocol/server-everything@latest' ./scripts/smoke.sh
#
# Requires: node >= 20, network access (npx downloads the reference server).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli.js"

# The reference server is pinned on purpose, not out of caution about npx.
# MCP is still churning: the 2026-07-28 stateless lifecycle is recent, and
# mcp-cassette v0.1 only speaks the classic lifecycle. On `@latest`, an
# upstream release that went stateless-only would turn CI red on main with no
# change on our side. The non-blocking weekly `smoke-canary` job in
# .github/workflows/ci.yml runs this same script against `@latest` so we learn
# about that drift early instead of during someone's PR.
# Bump this pin deliberately, as its own commit.
SERVER_PKG="${SERVER_PKG:-@modelcontextprotocol/server-everything@2026.7.4}"
SERVER="npx -y $SERVER_PKG stdio"

if [ ! -f "$CLI" ]; then
  echo "smoke: $CLI not found — run 'npm run build' first" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CASSETTE="$WORK/smoke.cassette.jsonl"
SNAPSHOT="$WORK/smoke.snapshot.json"

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

echo "reference server: $SERVER_PKG"

# The --stdio value is tokenized by the CLI (quotes honored), so inner paths are
# quoted to survive spaces in the checkout or temp directory.
REPLAY_CMD="node \"$CLI\" replay \"$CASSETTE\""

step "1/5 check the live reference server"
node "$CLI" check --stdio "$SERVER"

step "2/5 record a session by driving the record proxy with check"
node "$CLI" check --stdio "node \"$CLI\" record -o \"$CASSETTE\" -- $SERVER"

# The proxy flushes the cassette as its child shuts down, so the file can lag
# the `check` above. Poll for the finished state instead of sleeping a fixed
# interval: a fixed wait is a race that a slow or loaded runner loses, and a
# flaky suite is a bad look for a tool that sells deterministic testing.
WAIT_SECONDS=15
POLL_INTERVAL=0.25
deadline=$(( SECONDS + WAIT_SECONDS ))

while :; do
  if [ -s "$CASSETTE" ] && grep -q '"method":"initialize"' "$CASSETTE"; then
    break
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    if [ ! -s "$CASSETTE" ]; then
      echo "smoke: no cassette was written to $CASSETTE within ${WAIT_SECONDS}s" >&2
    else
      echo "smoke: cassette at $CASSETTE still has no initialize frame after ${WAIT_SECONDS}s" >&2
      echo "smoke: $(wc -l <"$CASSETTE" | tr -d ' ') line(s) present when the wait expired" >&2
    fi
    exit 1
  fi
  sleep "$POLL_INTERVAL"
done

echo "cassette: $(wc -l <"$CASSETTE" | tr -d ' ') lines recorded"

step "3/5 check against the replayed cassette (offline)"
node "$CLI" check --stdio "$REPLAY_CMD"

step "4/5 snapshot the replayed contract"
node "$CLI" snapshot --stdio "$REPLAY_CMD" -f "$SNAPSHOT"

step "5/5 snapshot --check the replay (must report no drift)"
node "$CLI" snapshot --check --stdio "$REPLAY_CMD" -f "$SNAPSHOT"

printf '\n\033[1;32msmoke: all 5 steps passed\033[0m\n'
