-- Minimal gateway_clients table used by remorses/gateway-proxy
-- (branch multi-client-support) and the VM onboarding HTTP service.
-- Proxy SELECT is: client_id, secret, guild_id, reachable_url
-- ordered by client_id, updated_at, created_at.
-- Primary key (client_id, guild_id) matches the proxy README and Prisma model.
-- Extra website columns (platform, user_id, bot_token) are not required here.

CREATE TABLE IF NOT EXISTS gateway_clients (
  client_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  reachable_url TEXT,
  discord_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (client_id, guild_id)
);
