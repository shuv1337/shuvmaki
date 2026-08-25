#!/usr/bin/env node
// Minimal shuvmaki onboarding HTTP for a self-hosted Discord gateway stack.
//
// The full website is a Cloudflare Worker (better-auth, Hyperdrive, KV, Prisma
// User relations). That is too large to run on an exe.dev VM. This process
// implements only the CLI contract used by `kimaki --gateway`:
//
// 1. GET /discord-install?clientId=&clientSecret=[&kimakiCallbackUrl][&reachableUrl]
//    Redirects to Discord OAuth (bot + applications.commands, prompt=consent,
//    permissions 17927465446480 from website/src/auth.ts).
// 2. GET /api/auth/callback/discord
//    Same path as better-auth so the Discord Developer Portal redirect URI
//    stays /api/auth/callback/discord. Exchanges code, upserts gateway_clients.
// 3. GET /api/onboarding/status?client_id=&secret=
//    200 { guild_id, discord_user_id? } or 404 { error, onboarding_error? }.
// 4. GET /install-success  GET /health
//
// CLI env: KIMAKI_WEBSITE_URL must be this service's public HTTPS origin.
// CLI then IDENTIFYs to gateway-proxy as clientId:clientSecret.
// Public key / Interactions Endpoint are not used (gateway, not HTTP interactions).
// Message Content Intent must be enabled on the Discord application; proxy
// IDENTIFY intents must include 32768 or message bodies are empty.

import crypto from 'node:crypto'
import http from 'node:http'
import pg from 'pg'

const DISCORD_BOT_PERMISSIONS = '17927465446480'
const DISCORD_AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize'
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token'
const STATE_TTL_MS = 10 * 60 * 1000
const ONBOARDING_ERROR_TTL_MS = 10 * 60 * 1000

const onboardingErrors = new Map()

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env ${name}`)
  }
  return value
}

function publicWebsiteUrl() {
  return requiredEnv('PUBLIC_WEBSITE_URL').replace(/\/+$/, '')
}

function oauthRedirectUri() {
  return new URL('/api/auth/callback/discord', `${publicWebsiteUrl()}/`).toString()
}

function htmlPage({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <h1>shuvmaki</h1>
  ${body}
</body>
</html>`
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function jsonResponse({ status, body }) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }
}

function redirectResponse(location) {
  return {
    status: 302,
    headers: { location },
    body: '',
  }
}

function htmlResponse({ status = 200, title, body }) {
  return {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: htmlPage({ title, body }),
  }
}

function parseAllowedCallbackUrl(raw) {
  if (!raw) {
    return null
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol === 'https:') {
    return url
  }
  if (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) {
    return url
  }
  return null
}

function assertReachableUrl(raw) {
  if (!raw) {
    return
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new HttpError(400, 'reachableUrl is not a valid URL')
  }
  if (url.protocol !== 'https:') {
    throw new HttpError(400, 'reachableUrl must use https')
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
    this.name = 'HttpError'
  }
}

function signState({ payload, secret }) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const hmac = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${hmac}`
}

function verifyState({ state, secret }) {
  const parts = state.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }
  const [encoded, givenHmac] = parts
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url')
  const given = Buffer.from(givenHmac)
  const expected = Buffer.from(expectedHmac)
  if (given.length !== expected.length) {
    return null
  }
  if (!crypto.timingSafeEqual(given, expected)) {
    return null
  }
  let payload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') {
    return null
  }
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
    return null
  }
  if (typeof payload.clientId !== 'string' || typeof payload.clientSecret !== 'string') {
    return null
  }
  return payload
}

function rememberOnboardingError({ clientId, message }) {
  onboardingErrors.set(clientId, {
    error: message,
    expiresAt: Date.now() + ONBOARDING_ERROR_TTL_MS,
  })
}

function readOnboardingError(clientId) {
  const stored = onboardingErrors.get(clientId)
  if (!stored) {
    return null
  }
  if (Date.now() > stored.expiresAt) {
    onboardingErrors.delete(clientId)
    return null
  }
  return stored.error
}

function installSuccessUrl({ error }) {
  const url = new URL('/install-success', `${publicWebsiteUrl()}/`)
  if (error) {
    url.searchParams.set('error', error)
  }
  return url.toString()
}

async function handleDiscordInstall({ url, authSecret }) {
  const clientId = url.searchParams.get('clientId')
  const clientSecret = url.searchParams.get('clientSecret')
  const kimakiCallbackUrl = url.searchParams.get('kimakiCallbackUrl')
  const reachableUrl = url.searchParams.get('reachableUrl')

  if (!clientId || !clientSecret) {
    throw new HttpError(400, 'Missing clientId or clientSecret')
  }
  assertReachableUrl(reachableUrl)
  if (kimakiCallbackUrl && !parseAllowedCallbackUrl(kimakiCallbackUrl)) {
    throw new HttpError(400, 'kimakiCallbackUrl must use https (or http for localhost)')
  }

  const state = signState({
    secret: authSecret,
    payload: {
      clientId,
      clientSecret,
      kimakiCallbackUrl,
      reachableUrl,
      exp: Date.now() + STATE_TTL_MS,
    },
  })

  const authorizeUrl = new URL(DISCORD_AUTHORIZE_URL)
  authorizeUrl.searchParams.set('client_id', requiredEnv('DISCORD_CLIENT_ID'))
  authorizeUrl.searchParams.set('permissions', DISCORD_BOT_PERMISSIONS)
  authorizeUrl.searchParams.set('scope', 'bot applications.commands')
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('redirect_uri', oauthRedirectUri())
  authorizeUrl.searchParams.set('prompt', 'consent')
  authorizeUrl.searchParams.set('state', state)
  return redirectResponse(authorizeUrl.toString())
}

async function exchangeDiscordCode({ code }) {
  const body = new URLSearchParams({
    client_id: requiredEnv('DISCORD_CLIENT_ID'),
    client_secret: requiredEnv('DISCORD_CLIENT_SECRET'),
    grant_type: 'authorization_code',
    code,
    redirect_uri: oauthRedirectUri(),
  })
  const response = await fetch(DISCORD_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = await response.json().catch(() => {
    return null
  })
  if (!response.ok) {
    throw new Error('Discord token exchange failed')
  }
  return json
}

async function upsertGatewayClient({
  pool,
  clientId,
  secret,
  guildId,
  reachableUrl,
}) {
  await pool.query(
    `INSERT INTO gateway_clients (client_id, secret, guild_id, reachable_url, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (client_id, guild_id)
     DO UPDATE SET secret = EXCLUDED.secret, reachable_url = EXCLUDED.reachable_url, updated_at = NOW()`,
    [clientId, secret, guildId, reachableUrl || null],
  )
  await pool.query(
    `UPDATE gateway_clients SET secret = $2, updated_at = NOW() WHERE client_id = $1`,
    [clientId, secret],
  )
}

async function handleDiscordCallback({ url, authSecret, pool }) {
  const oauthError = url.searchParams.get('error')
  const state = url.searchParams.get('state') || ''
  const payload = verifyState({ state, secret: authSecret })

  if (oauthError) {
    const message = url.searchParams.get('error_description') || oauthError
    if (payload?.clientId) {
      rememberOnboardingError({ clientId: payload.clientId, message })
    }
    return redirectResponse(installSuccessUrl({ error: message }))
  }

  if (!payload) {
    return redirectResponse(
      installSuccessUrl({ error: 'OAuth state was missing or expired. Try installing again.' }),
    )
  }

  const fail = (message) => {
    rememberOnboardingError({ clientId: payload.clientId, message })
    return redirectResponse(installSuccessUrl({ error: message }))
  }

  const code = url.searchParams.get('code')
  if (!code) {
    return fail('Discord did not return an authorization code. Try authorizing again.')
  }

  let token
  try {
    token = await exchangeDiscordCode({ code })
  } catch {
    return fail('Discord token exchange failed. Check DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.')
  }

  const guildId =
    url.searchParams.get('guild_id') ||
    (token && typeof token === 'object' && token.guild && typeof token.guild.id === 'string'
      ? token.guild.id
      : undefined)
  if (!guildId) {
    return fail(
      'Discord did not return guild_id in the callback. Try authorizing again and make sure to select a server.',
    )
  }

  try {
    await upsertGatewayClient({
      pool,
      clientId: payload.clientId,
      secret: payload.clientSecret,
      guildId,
      reachableUrl: payload.reachableUrl,
    })
  } catch (error) {
    console.error('gateway onboarding upsert failed', error)
    return fail('shuvmaki could not save the bot installation. Please try again.')
  }

  const parsedCallback = parseAllowedCallbackUrl(payload.kimakiCallbackUrl)
  if (parsedCallback) {
    parsedCallback.searchParams.set('guild_id', guildId)
    parsedCallback.searchParams.set('client_id', payload.clientId)
    return redirectResponse(parsedCallback.toString())
  }

  return redirectResponse(installSuccessUrl({ error: undefined }))
}

async function handleOnboardingStatus({ url, pool }) {
  const clientId = url.searchParams.get('client_id')
  const secret = url.searchParams.get('secret')
  if (!clientId || !secret) {
    return jsonResponse({
      status: 400,
      body: { error: 'Missing client_id or secret' },
    })
  }

  const result = await pool.query(
    `SELECT guild_id FROM gateway_clients WHERE client_id = $1 AND secret = $2 LIMIT 1`,
    [clientId, secret],
  )
  const row = result.rows[0]
  if (row) {
    return jsonResponse({
      status: 200,
      body: { guild_id: row.guild_id },
    })
  }

  const storedError = readOnboardingError(clientId)
  if (storedError) {
    return jsonResponse({
      status: 404,
      body: { error: storedError, onboarding_error: true },
    })
  }

  return jsonResponse({
    status: 404,
    body: { error: 'Not found' },
  })
}

function handleInstallSuccess({ url }) {
  const error = url.searchParams.get('error')
  if (error) {
    return htmlResponse({
      title: 'shuvmaki install failed',
      body: `<p>Install did not finish.</p><p>${escapeHtml(error)}</p>`,
    })
  }
  return htmlResponse({
    title: 'shuvmaki installed',
    body: '<p>The shuvmaki bot is installed. You can close this tab and return to the CLI.</p>',
  })
}

async function ensureGatewayClientsTable({ pool }) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gateway_clients (
      client_id TEXT NOT NULL,
      secret TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      reachable_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (client_id, guild_id)
    )
  `)
}

async function routeRequest({ req, pool, authSecret }) {
  const host = req.headers.host || '127.0.0.1'
  const url = new URL(req.url || '/', `http://${host}`)
  if (req.method !== 'GET') {
    throw new HttpError(405, 'Method not allowed')
  }
  if (url.pathname === '/health') {
    return jsonResponse({ status: 200, body: { ok: true } })
  }
  if (url.pathname === '/discord-install') {
    return handleDiscordInstall({ url, authSecret })
  }
  if (url.pathname === '/api/auth/callback/discord') {
    return handleDiscordCallback({ url, authSecret, pool })
  }
  if (url.pathname === '/api/onboarding/status') {
    return handleOnboardingStatus({ url, pool })
  }
  if (url.pathname === '/install-success') {
    return handleInstallSuccess({ url })
  }
  throw new HttpError(404, 'Not found')
}

async function main() {
  const authSecret = requiredEnv('AUTH_SECRET')
  requiredEnv('DISCORD_CLIENT_ID')
  requiredEnv('DISCORD_CLIENT_SECRET')
  publicWebsiteUrl()

  const pool = new pg.Pool({ connectionString: requiredEnv('DATABASE_URL') })
  await ensureGatewayClientsTable({ pool })

  const port = Number(process.env.PORT || '8080')
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const result = await routeRequest({ req, pool, authSecret })
        res.writeHead(result.status, result.headers)
        res.end(result.body)
      } catch (error) {
        if (error instanceof HttpError) {
          res.writeHead(error.status, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(error.message)
          return
        }
        console.error(error)
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Internal server error')
      }
    })()
  })

  server.listen(port, () => {
    console.log(`shuvmaki onboarding listening on ${port}`)
  })
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
