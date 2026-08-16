# mcp-cassette demo, render with: vhs demo.tape
# Needs mcp-cassette on PATH and a warm npx cache for
# @modelcontextprotocol/server-everything. The [BREAKING] scene reads
# demo.snapshot.json, a contract snapshot edited to disagree with the live
# server (one extra tool, one required parameter removed).

Output demo.gif

Set FontSize 22
Set Width 1240
Set Height 700
Set Padding 24
Set Framerate 20
Set TypingSpeed 25ms
Set Theme { "name": "cassette", "background": "#131311", "foreground": "#ECEAE2", "cursor": "#E8935B", "black": "#131311", "red": "#E05252", "green": "#7FB069", "yellow": "#E8935B", "blue": "#7A9CC6", "magenta": "#B58DAE", "cyan": "#7FB0A8", "white": "#ECEAE2", "brightBlack": "#8A8578", "brightRed": "#E05252", "brightGreen": "#7FB069", "brightYellow": "#E8935B", "brightBlue": "#7A9CC6", "brightMagenta": "#B58DAE", "brightCyan": "#7FB0A8", "brightWhite": "#FFFFFF", "selection": "#3A372F" }

Type "# health-check a live MCP server"
Enter
Type `mcp-cassette check --stdio "npx -y @modelcontextprotocol/server-everything stdio"`
Enter
Sleep 5s

Type "# record a real session through the proxy"
Enter
Type `mcp-cassette check --stdio "mcp-cassette record -o session.cassette.jsonl -- npx -y @modelcontextprotocol/server-everything stdio"`
Enter
Sleep 4.5s

Type "# replay it offline — the cassette is the server now"
Enter
Type `mcp-cassette check --stdio "mcp-cassette replay session.cassette.jsonl"`
Enter
Sleep 4s

Type "# fail CI on breaking contract changes"
Enter
Type `mcp-cassette snapshot --check -f demo.snapshot.json --stdio "mcp-cassette replay session.cassette.jsonl"`
Enter
Sleep 6s
