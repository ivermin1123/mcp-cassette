# Cassette format v2 — design sketch

Status: **format implemented** as firmed up by
`docs/design/http-record-replay.md` — `src/cassette.ts` writes v2 (header
`era`/`url`/`sessioned`, `chunks[]`, `http.status`) and reads v1 forever. The
HTTP record/replay behavior that fills these fields lands over the v0.3 PR
sequence; `state`/`seq` below remains a sketch. This document is kept as the
rationale for the shape.

## Why plan v2 now

Three pressures are visible from the v1 shape:

1. **Streamed results.** The MCP roadmap points toward streamed/partial tool
   results. v1 stores exactly one response frame per request id; a streamed
   result is many chunks that only together form the response. This is the
   single biggest format risk, so v2 reserves its shape first.
2. **Lifecycle eras.** Servers currently speak the classic lifecycle
   (`initialize` → `notifications/initialized` → requests); the 2026-07-28
   revision sketches a stateless one. Replay and verify need to know which
   world a cassette was recorded in without sniffing frames.
3. **Scenario states.** VCR-style workflows want one cassette to answer the
   same request differently as a scenario progresses ("first call fails,
   retry succeeds" is today only expressible through recorded-order pools).

## Shape

v2 keeps everything that made v1 workable: an open, append-only JSONL file,
one JSON object per line, header first. A v2 file is a v1 file with a bumped
version and new, optional fields — no field of v1 is renamed or removed.

### Header

```jsonc
{
  "type": "header",
  "cassetteVersion": 2,
  "recorder": "mcp-cassette@0.2.0",
  "startedAt": "2026-08-15T09:00:00Z",
  "transport": "stdio",
  "command": ["npx", "-y", "some-server"],
  "redaction": { "applied": true },

  // NEW: which lifecycle the recorded session spoke.
  //   "legacy": classic initialize handshake (every v1 cassette is this)
  //   "modern": the stateless lifecycle, once the spec ships it
  "era": "legacy"
}
```

`era` tells replay whether to expect (and verify whether to perform) an
initialize handshake. Readers treat a missing `era` as `"legacy"` — which is
also the v1→v2 migration rule.

### Frame entries

Unchanged from v1:

```jsonc
{ "type": "frame", "t": 1204, "dir": "c2s", "frame": { /* JSON-RPC */ } }
{ "type": "raw",   "t": 1210, "dir": "s2c", "data": "non-JSON-RPC line" }
```

Two optional fields join them:

```jsonc
{
  "type": "frame",
  "t": 1204,
  "dir": "s2c",
  "frame": { /* JSON-RPC */ },

  // Already written by v1's `replay --on-miss passthrough` (spy mode):
  // marks interactions captured live after the original recording.
  "origin": "live",

  // NEW: scenario state (see below).
  "state": "after-first-failure",
  "seq": 3
}
```

### `chunks[]` — streamed results

When a response arrives as a stream, the single `frame` field cannot hold it
without inventing a merged payload that never existed on the wire. v2 reserves
a `chunks` entry type for this:

```jsonc
{
  "type": "chunks",
  "t": 1204,
  "dir": "s2c",
  "id": 7,                    // the request id the stream answers
  "chunks": [
    { "t": 1204, "frame": { /* partial/notification frame as sent */ } },
    { "t": 1290, "frame": { /* ... */ } },
    { "t": 1355, "frame": { /* final frame that completes the response */ } }
  ]
}
```

The HTTP recorder writes these today: an SSE answer becomes one `chunks` entry
when its stream ends, with two fields the sketch did not name —
`id` (absent on the legacy standalone GET stream, which answers no request) and
`via` (`"post"` by default and then omitted, `"get"` for that GET stream).
`docs/design/http-record-replay.md` §1.3 is the authority on both.

Design intent, firmed up in §1.3 of that document:

- Each chunk stores the frame **as it appeared on the wire** (after redaction)
  — the cassette stays a transcript, not an interpretation. SSE event ids,
  `retry` fields, and keep-alive comment lines are parsed and dropped: the
  modern era deleted resumability, and comment lines are data-free by
  definition.
- Replay of a `chunks` entry emits every chunk in order (optionally honoring
  the recorded timing offsets), so streaming clients exercise their real code
  path.
- Verify treats the final chunk as the response payload for diffing and may
  compare chunk counts as a shape check.
- A v2 reader that predates streamed-results support may refuse `chunks`
  entries with a clear "recorded with a newer mcp-cassette" error — but it can
  still parse the file, because unknown entry types are skippable by design.

### `state` / `seq` — scenario states

v1 answers repeated identical requests from an ordered pool, which encodes
"first call, then second call" implicitly. v2 makes progression explicit:

- `state` (string, optional): the named scenario state this interaction
  belongs to (`"initial"` when absent).
- `seq` (number, optional): total order of interactions within a state, for
  writers that append out of wire order (a passthrough spy writing while the
  original recording already occupies earlier lines).

A future `replay --scenario` can then start in `initial` and move between
states via an explicit trigger (a control request, or "state advances when its
pool is exhausted" — to be decided). Without `--scenario`, replay ignores both
fields and behaves exactly like v1 — the fields are annotations, not a new
matching engine.

## Backward compatibility principles

These are the commitments; everything above is negotiable detail.

1. **v1 files never break.** Every reader that understands v2 must read v1
   files forever. v1 has no `era`: readers assume `"legacy"`.
2. **Additive, never destructive.** v2 adds fields and entry types; it never
   renames, removes, or re-types a v1 field. A v1 cassette is byte-for-byte a
   valid v2 cassette except for the version number.
3. **Unknown is skippable.** Readers skip entry types they don't recognize
   (warning, not error), exactly like v1 readers already ignore anything that
   is not `frame`/`raw`. This is what lets `chunks[]` land later without a
   version bump.
4. **JSONL, append-only, header-first stays.** Spy-append, `git diff`-ability,
   and stream-parsing all depend on it.
5. **One version bump, once.** We bump `cassetteVersion` to 2 when the first
   v2-only field ships (likely `era`), not per-field. Until then, additive
   optional fields (like `origin`) ride on v1, as `origin:"live"` already does.
