---
"kimaki": minor
---

Require the shuvcode CLI (Latitudes-Dev/shuvcode) instead of upstream OpenCode. Startup installs `shuvcode` from npm, serve uses `--port` only (drops `--print-logs`; `--log-level` is still valid but omitted from the default argv), generates the required server password, and hands it to other kimaki processes through a 0600 data-dir file. `/kimaki/opencode-port` returns only the port. `/session-id` shows `kimaki attach` so the password never appears in Discord. `OPENCODE_PATH` pointing at upstream opencode is ignored. Windows attach quoting leaves `%` unchanged because cmd.exe cannot escape percents. The Discord bot still uses `@opencode-ai/sdk/v2`, pointed at `http://127.0.0.1:<port>/api`, because shuvcode v2 mounts the HTTP API under `/api/*`. A fetch adapter rewrites session create bodies to `{ title, location }`, maps `prompt_async` to `prompt` and `abort` to `interrupt`, unwraps `{ data }` JSON, and translates shuvcode v2 SSE events into the shapes the Discord runtime already understands. Health checks require JSON. Worktrees use git directly because shuvcode has no experimental workspace API.

Fixes #7
