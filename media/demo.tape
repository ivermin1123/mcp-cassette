# mcp-cassette demo.
#
# Render from the repository root, after putting this build on PATH:
#
#   npm run build && npm link
#   vhs media/demo.tape
#
# Offline on purpose. Every server in it is a fixture in tests/fixtures, so the
# tape renders the same with the network unplugged and cannot be derailed by a
# registry, a rate limit, or a reference server changing its tool count. The
# recording is written under demo/, which .gitignore already covers.

Output .github/demo.gif

Set FontSize 22
Set Width 1240
Set Height 760
Set Padding 24
Set Framerate 20
Set TypingSpeed 25ms
Set Theme { "name": "cassette", "background": "#131311", "foreground": "#ECEAE2", "cursor": "#E8935B", "black": "#131311", "red": "#E05252", "green": "#7FB069", "yellow": "#E8935B", "blue": "#7A9CC6", "magenta": "#B58DAE", "cyan": "#7FB0A8", "white": "#ECEAE2", "brightBlack": "#8A8578", "brightRed": "#E05252", "brightGreen": "#7FB069", "brightYellow": "#E8935B", "brightBlue": "#7A9CC6", "brightMagenta": "#B58DAE", "brightCyan": "#7FB0A8", "brightWhite": "#FFFFFF", "selection": "#3A372F" }

Hide
Type "mkdir -p demo && rm -f demo/demo.cassette.jsonl && clear"
Enter
Sleep 1s
Show

Type "# health-check a live MCP server"
Enter
Type `mcp-cassette check --stdio "node tests/fixtures/tiny-server.mjs"`
Enter
Sleep 4s

Type "# record that session through the proxy"
Enter
Type `mcp-cassette check --stdio "mcp-cassette record -o demo/demo.cassette.jsonl -- node tests/fixtures/tiny-server.mjs"`
Enter
Sleep 4s

Type "# replay it: the cassette is the server now, and nothing else runs"
Enter
Type `mcp-cassette check --stdio "mcp-cassette replay demo/demo.cassette.jsonl"`
Enter
Sleep 4.5s

Type "clear"
Enter
Sleep 500ms

Type "# the safety lint reads every text a server publishes to the model"
Enter
Type `TINY_SURFACES=1 mcp-cassette check --stdio "node tests/fixtures/tiny-server.mjs"`
Enter
Sleep 6s

Type "clear"
Enter
Sleep 500ms

Type "# and what a recorded server handed back, which is the other half"
Enter
Type "mcp-cassette lint tests/fixtures/poisoned-output.cassette.jsonl"
Enter
Sleep 5s

Type "# fail CI on breaking contract changes"
Enter
Type `TINY_V2=1 mcp-cassette snapshot --check -f tests/fixtures/tiny-server.snapshot.json --stdio "node tests/fixtures/tiny-server.mjs"`
Enter
Sleep 6s
