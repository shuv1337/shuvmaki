---
'kimaki': patch
---

Keep unapproved Discord users silent.

shuvmaki now requires a durable user-id allowlist (`allowed-users.json`, plus optional `SHUVMAKI_ALLOWED_USER_IDS`) before anyone can use commands or existing threads. Role, admin, owner, and `--allow-all-users` are no longer enough on their own. Unapproved users get no bot reply.

Fixes #3
