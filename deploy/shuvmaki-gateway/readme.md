---
title: Self-hosted shuvmaki Discord gateway
description: Compose stack for postgres, gateway-proxy, and VM onboarding HTTP
  so shuvmaki can run the Discord gateway on kimaki.exe.xyz instead of
  kimaki.dev.
prompt: |
  Follow-up on the same shuvmaki branch/PR: add a self-hosted shuvmaki
  gateway stack (docs + compose/config only, no secrets, do not register a
  Discord app). Goal: run OUR Discord-gateway-proxy + onboarding on exe.dev
  (kimaki.exe.xyz), not kimaki.dev. Upstream facts: CLI honors
  KIMAKI_WEBSITE_URL, KIMAKI_GATEWAY_APP_ID, KIMAKI_GATEWAY_PROXY_URL.
  --gateway generates clientId+clientSecret, opens /discord-install,
  website OAuth-callbacks into Postgres gateway_clients, CLI polls
  /api/onboarding/status, then IDENTIFY to the proxy as clientId:clientSecret.
  gateway-proxy is submodule remorses/gateway-proxy branch
  multi-client-support. Config: token or TOKEN env, intents 32511, port 7878,
  externally_accessible_url, optional clients map. DB DIRECT_DATABASE_URL or
  DATABASE_URL, table gateway_clients (client_id, secret, guild_id).
  @cli/src/utils.ts @cli/src/cli-runner.ts @website/src/auth.ts
  @website/src/server.tsx @gateway-proxy/README.md
  @gateway-proxy/src/config.rs @gateway-proxy/src/db_config.rs
  @db/schema.prisma
---

# Self-hosted shuvmaki gateway

This directory is a **compose/config example** for running the shared Discord
bot on **exe.dev** (`kimaki.exe.xyz`), not kimaki.dev. It does not register a
Discord application and does not contain tokens.

Stack:

1. **Postgres** — `gateway_clients` rows the proxy polls
2. **gateway-proxy** — `remorses/gateway-proxy` branch `multi-client-support`,
   port **7878**
3. **onboarding HTTP** — the three routes `kimaki --gateway` already calls

The Cloudflare Worker website (`website/`, wrangler route kimaki.dev) is **not**
required on the VM. A tiny Node server here implements the CLI contract.

## Kyle: Discord Developer Portal secrets

Create (or reuse) **your** Discord application. Name the bot **shuvmaki**.
Copy these four values into `.env`. Do not invent them and do not commit them.

| Secret | Portal location | Compose / CLI env |
|---|---|---|
| Bot token | Bot → Token | `DISCORD_BOT_TOKEN` (proxy `TOKEN`) |
| OAuth client id | OAuth2 → Client ID | `DISCORD_CLIENT_ID` |
| OAuth client secret | OAuth2 → Client Secret | `DISCORD_CLIENT_SECRET` |
| Application id | General Information → Application ID | `DISCORD_APPLICATION_ID` and CLI `KIMAKI_GATEWAY_APP_ID` |

On a Discord application, **OAuth2 Client ID and Application ID are the same
string**. Public Key is **not** required (no HTTP Interactions endpoint).

### Redirect URI (exact)

OAuth2 → General → Redirects, add exactly:

```
https://kimaki.exe.xyz/api/auth/callback/discord
```

If `PUBLIC_WEBSITE_URL` is different, the redirect URI is
`{PUBLIC_WEBSITE_URL}/api/auth/callback/discord`. It must match the onboarding
service. Discord requires **https** except for localhost.

### Privileged intents

Bot → Privileged Gateway Intents:

- **Message Content Intent**: required (on). Without it, message bodies are empty.
- Presence Intent: off unless you change proxy intents.
- Server Members Intent: not required for this stack.

OAuth scopes requested at install time (not a portal redirect setting):
`bot` and `applications.commands`. Bot permissions bitfield sent to Discord is
`17927465446480` (same list as `website/src/auth.ts` / `generateBotInstallUrl`).

`prompt=consent` is always sent so Discord includes `guild_id` on the callback.

## Proxy intents (32511 + Message Content)

`gateway-proxy` README examples use **intents 32511**. That bitfield does **not**
include MESSAGE_CONTENT (`32768`). This compose uses **65279**
(`32511 | 32768`) so IDENTIFY asks for message content after you enable the
privileged intent in the portal.

Port is **7878**. `token` may be omitted in JSON; the binary reads `TOKEN`.
`externally_accessible_url` must be the public `wss://` URL (CLI
`KIMAKI_GATEWAY_PROXY_URL`). REST is the same host with `https`
(CLI swaps `wss` → `https`).

Optional `clients` map in config.json is a static seed. After
`DIRECT_DATABASE_URL` / `DATABASE_URL` syncs, Postgres is the source of truth.

Table (proxy SELECT also reads `reachable_url`, `updated_at`, `created_at`):

```
gateway_clients (client_id, secret, guild_id) PK (client_id, guild_id)
```

## CLI env (point at this host, not kimaki.dev)

On machines that run `kimaki --gateway`:

```bash
export KIMAKI_WEBSITE_URL=https://kimaki.exe.xyz
export KIMAKI_GATEWAY_PROXY_URL=wss://discord-gateway.kimaki.exe.xyz
export KIMAKI_GATEWAY_APP_ID=<Kyle's Application ID>
```

See `cli.env.example`. Do not hardcode secrets. When `KIMAKI_WEBSITE_URL` is
not `https://kimaki.dev`, the CLI **does not** default `KIMAKI_GATEWAY_APP_ID`
to the kimaki.dev bot `1477605701202481173` — that variable is required.

Then:

```bash
kimaki --gateway
```

The CLI generates `clientId` + `clientSecret`, opens
`$KIMAKI_WEBSITE_URL/discord-install?...`, polls
`$KIMAKI_WEBSITE_URL/api/onboarding/status?client_id=&secret=`, then IDENTIFYs
to the proxy as `clientId:clientSecret`.

## Run on the VM

```bash
git submodule update --init gateway-proxy
cd deploy/shuvmaki-gateway
cp env.example .env
# paste Kyle's four Discord secrets, AUTH_SECRET, URLs, postgres password
docker compose up --build
```

First proxy image build compiles the Rust submodule (nightly, `TARGET_CPU=x86-64`).
Put TLS in front with `caddyfile.example` (or exe.dev HTTPS):

- `kimaki.exe.xyz` → onboarding `:8080`
- `discord-gateway.kimaki.exe.xyz` → gateway-proxy `:7878` (WebSocket + REST)

To mount a config file instead of the compose `CONFIG` env, copy
`config.example.json` to `config.json` (gitignored), leave `token` omitted, set
`TOKEN`, mount at `/config.json`.

`docker.io/gelbpunkt/gateway-proxy` is the **upstream** binary. It does not
sync `gateway_clients` from Postgres. This compose **builds the submodule**.

## Onboarding routes (VM, no Cloudflare)

| Method | Path | CLI / Discord |
|---|---|---|
| GET | `/discord-install` | CLI opens this |
| GET | `/api/auth/callback/discord` | Discord OAuth redirect |
| GET | `/api/onboarding/status` | CLI polls |
| GET | `/install-success` | browser after authorize |
| GET | `/health` | compose healthcheck |

This is **not** the full website. It does not implement better-auth sessions,
KV, `/api/transcribe`, Slack, or docs. If you later point the Cloudflare Worker
at this public URL instead, it must still serve the four onboarding routes
above and use the same Postgres `gateway_clients` table.

## AUTH_SECRET

Not a Discord value. HMAC key for OAuth `state`. Generate with
`openssl rand -hex 32`.
