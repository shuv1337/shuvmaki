---
"kimaki": minor
---

Require the shuvcode CLI (Latitudes-Dev/shuvcode) instead of upstream OpenCode. Startup installs `shuvcode` from npm, serve uses `--port` only, generates the required server password, hands it to other kimaki processes over localhost `/kimaki/opencode-port`, and `/session-id` shows `kimaki attach` so the password never appears in Discord.

Fixes #7
