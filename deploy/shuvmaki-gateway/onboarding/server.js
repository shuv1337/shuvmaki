#!/usr/bin/env node
// Minimal shuvmaki onboarding HTTP for a self-hosted Discord gateway stack.
//
// The full website is a Cloudflare Worker (better-auth, Hyperdrive, KV, Prisma
// User relations). That is too large to run on an exe.dev VM. This process
// implements only the CLI contract used by `kimaki --gateway`:
//
// 1. GET /discord-install?clientId=&clientSecret=[&kimakiCallbackUrl][&reachableUrl]
//    Stores credentials server-side, sets an HttpOnly cookie, and redirects to
//    Discord OAuth with a random state id only (bot + applications.commands +
//    identify, prompt=consent, permissions 17927465446480 from website/src/auth.ts).
//    clientSecret never appears on the Discord authorize URL.
// 2. GET /api/auth/callback/discord
//    Same path as better-auth so the Discord Developer Portal redirect URI
//    stays /api/auth/callback/discord. Cookie must match state. Exchanges code,
//    fetches Discord user id, upserts gateway_clients.
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
const DISCORD_USERS_ME_URL = 'https://discord.com/api/v10/users/@me'
const STATE_TTL_MS = 10 * 60 * 1000
const ONBOARDING_ERROR_TTL_MS = 10 * 60 * 1000
const OAUTH_COOKIE_NAME = 'shuvmaki_oauth'

const onboardingErrors = new Map()
const pendingOAuthStates = new Map()

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

function redirectResponse({ location, extraHeaders = {} }) {
  return {
    status: 302,
    headers: { location, ...extraHeaders },
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

function signCookieValue({ stateId, secret }) {
  const hmac = crypto.createHmac('sha256', secret).update(stateId).digest('base64url')
  return `${stateId}.${hmac}`
}

function verifyCookieValue({ cookieValue, secret }) {
  const parts = cookieValue.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }
  const [stateId, givenHmac] = parts
  const expectedHmac = crypto.createHmac('sha256', secret).update(stateId).digest('base64url')
  const given = Buffer.from(givenHmac)
  const expected = Buffer.from(expectedHmac)
  if (given.length !== expected.length) {
    return null
  }
  if (!crypto.timingSafeEqual(given, expected)) {
    return null
  }
  return stateId
}

function parseCookies(header) {
  const cookies = new Map()
  if (!header) {
    return cookies
  }
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) {
      continue
    }
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    cookies.set(key, value)
  }
  return cookies
}

function oauthCookieHeader({ stateId, secret }) {
  const value = signCookieValue({ stateId, secret })
  const parts = [
    `${OAUTH_COOKIE_NAME}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(STATE_TTL_MS / 1000)}`,
  ]
  if (publicWebsiteUrl().startsWith('https://')) {
    parts.push('Secure')
  }
  return parts.join('; ')
}

function pruneExpiredOAuthStates() {
  const now = Date.now()
  for (const [stateId, payload] of pendingOAuthStates) {
    if (now > payload.exp) {
      pendingOAuthStates.delete(stateId)
    }
  }
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

function handleDiscordInstall({ url, authSecret }) {
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

  pruneExpiredOAuthStates()
  const stateId = crypto.randomBytes(32).toString('base64url')
  pendingOAuthStates.set(stateId, {
    clientId,
    clientSecret,
    kimakiCallbackUrl,
    reachableUrl,
    exp: Date.now() + STATE_TTL_MS,
  })

  const authorizeUrl = new URL(DISCORD_AUTHORIZE_URL)
  authorizeUrl.searchParams.set('client_id', requiredEnv('DISCORD_CLIENT_ID'))
  authorizeUrl.searchParams.set('permissions', DISCORD_BOT_PERMISSIONS)
  authorizeUrl.searchParams.set('scope', 'bot applications.commands identify')
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('redirect_uri', oauthRedirectUri())
  authorizeUrl.searchParams.set('prompt', 'consent')
  authorizeUrl.searchParams.set('state', stateId)
  return redirectResponse({
    location: authorizeUrl.toString(),
    extraHeaders: {
      'set-cookie': oauthCookieHeader({ stateId, secret: authSecret }),
    },
  })
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

async function fetchDiscordUserId({ accessToken }) {
  if (!accessToken || typeof accessToken !== 'string') {
    return undefined
  }
  const response = await fetch(DISCORD_USERS_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    return undefined
  }
  const profile = await response.json().catch(() => {
    return null
  })
  if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string') {
    return undefined
  }
  return profile.id
}

async function upsertGatewayClient({
  pool,
  clientId,
  secret,
  guildId,
  reachableUrl,
  discordUserId,
}) {
  await pool.query(
    `INSERT INTO gateway_clients (client_id, secret, guild_id, reachable_url, discord_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (client_id, guild_id)
     DO UPDATE SET secret = EXCLUDED.secret, reachable_url = EXCLUDED.reachable_url, discord_user_id = EXCLUDED.discord_user_id, updated_at = NOW()`,
    [clientId, secret, guildId, reachableUrl || null, discordUserId || null],
  )
  await pool.query(
    `UPDATE gateway_clients SET secret = $2, updated_at = NOW() WHERE client_id = $1`,
    [clientId, secret],
  )
}

function readOAuthPayload({ url, cookieHeader, authSecret }) {
  const stateId = url.searchParams.get('state') || ''
  if (!stateId) {
    return null
  }
  const cookies = parseCookies(cookieHeader)
  const cookieValue = cookies.get(OAUTH_COOKIE_NAME)
  if (!cookieValue) {
    return null
  }
  const cookieStateId = verifyCookieValue({ cookieValue, secret: authSecret })
  if (!cookieStateId || cookieStateId !== stateId) {
    return null
  }
  pruneExpiredOAuthStates()
  const payload = pendingOAuthStates.get(stateId)
  if (!payload) {
    return null
  }
  if (Date.now() > payload.exp) {
    pendingOAuthStates.delete(stateId)
    return null
  }
  pendingOAuthStates.delete(stateId)
  return payload
}

async function handleDiscordCallback({ url, cookieHeader, authSecret, pool }) {
  const oauthError = url.searchParams.get('error')
  const payload = readOAuthPayload({ url, cookieHeader, authSecret })

  if (oauthError) {
    const message = url.searchParams.get('error_description') || oauthError
    if (payload?.clientId) {
      rememberOnboardingError({ clientId: payload.clientId, message })
    }
    return redirectResponse({ location: installSuccessUrl({ error: message }) })
  }

  if (!payload) {
    return redirectResponse({
      location: installSuccessUrl({
        error:
          'OAuth session was missing or expired. Start install from the same browser and try again.',
      }),
    })
  }

  const fail = (message) => {
    rememberOnboardingError({ clientId: payload.clientId, message })
    return redirectResponse({ location: installSuccessUrl({ error: message }) })
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

  const accessToken =
    token && typeof token === 'object' && typeof token.access_token === 'string'
      ? token.access_token
      : undefined
  const discordUserId = await fetchDiscordUserId({ accessToken })

  try {
    await upsertGatewayClient({
      pool,
      clientId: payload.clientId,
      secret: payload.clientSecret,
      guildId,
      reachableUrl: payload.reachableUrl,
      discordUserId,
    })
  } catch (error) {
    console.error('gateway onboarding upsert failed', error)
    return fail('shuvmaki could not save the bot installation. Please try again.')
  }

  const parsedCallback = parseAllowedCallbackUrl(payload.kimakiCallbackUrl)
  if (parsedCallback) {
    parsedCallback.searchParams.set('guild_id', guildId)
    parsedCallback.searchParams.set('client_id', payload.clientId)
    return redirectResponse({ location: parsedCallback.toString() })
  }

  return redirectResponse({ location: installSuccessUrl({ error: undefined }) })
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
    `SELECT guild_id, discord_user_id FROM gateway_clients WHERE client_id = $1 AND secret = $2 LIMIT 1`,
    [clientId, secret],
  )
  const row = result.rows[0]
  if (row) {
    const body = { guild_id: row.guild_id }
    if (row.discord_user_id) {
      body.discord_user_id = row.discord_user_id
    }
    return jsonResponse({
      status: 200,
      body,
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
      discord_user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (client_id, guild_id)
    )
  `)
  await pool.query(`
    ALTER TABLE gateway_clients ADD COLUMN IF NOT EXISTS discord_user_id TEXT
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
    return handleDiscordCallback({
      url,
      cookieHeader: req.headers.cookie,
      authSecret,
      pool,
    })
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
