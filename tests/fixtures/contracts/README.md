# Real contract snapshots, frozen

Contract snapshots captured from **real MCP servers**, committed unchanged. None
of these was written by hand: a hand-written schema proves the diff engine
handles the schema someone imagined, which is the schema the engine was already
written for.

They are test data with a hard gate on them — a diff test using one of these
fails CI like any other test. They are also the seed for later work that wants
real contracts rather than invented ones.

## Provenance

| File | Server | Captured |
|---|---|---|
| `pydantic-nested.contract.json` | `pydantic-nested-server.py` (below) | 2026-08-16 |
| `pydantic-nested-defs-changed.contract.json` | same, one edit (below) | 2026-08-16 |
| `pydantic-nested-defs-changed-and-root-relaxed.contract.json` | same, two edits (below) | 2026-08-16 |

**Toolchain at capture time**

| | |
|---|---|
| Python | 3.13.7 |
| `mcp` (Python SDK) | 1.9.4 |
| `pydantic` | 2.13.4 |
| `mcp-cassette` | 0.3.0, from npm |

`mcp` is pinned rather than latest on purpose: a later SDK renamed `McpError` to
`MCPError`, and the published Python servers of this era fail to import against
it. That rename is why these fixtures exist as frozen JSON instead of as a CI job
that starts a Python server — a test suite should not inherit another
ecosystem's breaking rename.

## Reproducing

```bash
python3 -m venv venv
./venv/bin/pip install 'mcp==1.9.4'

# 1. the base contract
./venv/bin/python tests/fixtures/contracts/pydantic-nested-server.py   # served on stdio
npx -y mcp-cassette@0.3.0 snapshot \
  --stdio "./venv/bin/python tests/fixtures/contracts/pydantic-nested-server.py" \
  -f pydantic-nested.contract.json

# 2. change only what lives inside $defs — Address.city: str -> int
sed 's/    city: str/    city: int/' pydantic-nested-server.py > v2a.py

# 3. the same $defs change, plus a root-level relaxation (user gains a default,
#    so it leaves `required`)
sed -e 's/    city: str/    city: int/' \
    -e 's/^def create_user(user: User, note: str = "")/def create_user(user: User = User(name="x", address=Address(street="s", city=1)), note: str = "")/' \
    pydantic-nested-server.py > v2b.py
```

## Why this particular server

FastMCP hands Pydantic the argument model, and Pydantic emits `$defs` + `$ref`
for any nested model, reused model, or `Enum` — here four `$ref`s, with the whole
contract living under `$defs` and the tool's own `properties` reduced to
`{"user": {"$ref": "#/$defs/User"}}`.

That shape is what makes these fixtures worth freezing. A diff that compares the
two `$ref` strings and finds them equal concludes "nothing changed" while the
contract underneath it changed completely.

A survey of seven published servers (four TypeScript/zod, three
Python/Pydantic — 50 tools) found **zero** `$ref` in the wild, because all of
them take flat scalar arguments. Read that as "not yet common among the
first-party servers sampled", not as "rare in general": every one of the seven
comes from the same organisation, and the sample skews simple. One nested model
is all it takes to land here.
