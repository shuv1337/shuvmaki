---
'kimaki': patch
---

Fail closed when a self-hosted gateway website URL is set without `KIMAKI_GATEWAY_PROXY_URL`, so onboarding cannot succeed against kimaki.dev's proxy.

Gateway-shaped `KIMAKI_BOT_TOKEN` values (`clientId:secret`) now use `KIMAKI_GATEWAY_APP_ID` for `kimaki project add` and other subcommands. The default Discord channel created in gateway mode is `#shuvmaki`.
