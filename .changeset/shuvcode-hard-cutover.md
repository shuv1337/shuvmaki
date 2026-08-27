---
"kimaki": minor
---

Require the shuvcode CLI (Latitudes-Dev/shuvcode) instead of upstream OpenCode. Startup installs `shuvcode` from npm, serve uses v2-safe flags, generates the required server password, and attach/MCP prompts use `shuvcode`.

Fixes #7
