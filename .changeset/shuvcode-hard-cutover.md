---
"kimaki": minor
---

Require the shuvcode CLI (Latitudes-Dev/shuvcode) instead of upstream OpenCode. Startup installs `shuvcode` from npm, serve uses `--port` only (drops `--print-logs`; `--log-level` is still valid but omitted from the default argv), generates the required server password, and hands it to other kimaki processes through a 0600 data-dir file. `/kimaki/opencode-port` returns only the port. `/session-id` shows `kimaki attach` so the password never appears in Discord. `OPENCODE_PATH` pointing at upstream opencode is ignored. Windows attach quoting leaves `%` unchanged because cmd.exe cannot escape percents.

Fixes #7
