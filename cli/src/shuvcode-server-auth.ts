// Cross-process shuvcode serve password handoff.
// The bot generates OPENCODE_PASSWORD in-process. CLI subcommands and
// `kimaki attach` run in separate processes, so they must recover the
// credential without putting it in Discord or on the internet-facing
// hrana listener. The 0600 file in the data dir is the only handoff.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import * as errore from 'errore'
import { FetchError, FilesystemOperationError, ShuvcodeAuthHandoffError } from './errors.js'
import { getSpawnCommandAndArgs } from './opencode-command.js'

export const SHUVCODE_SERVER_AUTH_FILENAME = 'shuvcode-server-auth.json'
export const SHUVCODE_SERVER_USERNAME_DEFAULT = 'opencode'

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.kimaki')

export type ShuvcodeServerAuth = {
  username: string
  password: string
}

export function getShuvcodeServerAuthFilePath({ dataDir }: { dataDir: string }) {
  return path.join(dataDir, SHUVCODE_SERVER_AUTH_FILENAME)
}

export function isDefaultKimakiDataDir(dataDir: string) {
  return path.resolve(dataDir) === DEFAULT_DATA_DIR
}

export function readShuvcodeServerAuthFromEnv({
  env = process.env,
}: {
  env?: NodeJS.ProcessEnv
} = {}): ShuvcodeServerAuth | null {
  const password = env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD
  if (!password || password.trim().length === 0) return null
  return {
    username: env.OPENCODE_SERVER_USERNAME || SHUVCODE_SERVER_USERNAME_DEFAULT,
    password,
  }
}

export function applyShuvcodeServerAuth({
  auth,
  env = process.env,
}: {
  auth: ShuvcodeServerAuth
  env?: NodeJS.ProcessEnv
}) {
  env.OPENCODE_PASSWORD = auth.password
  env.OPENCODE_SERVER_PASSWORD = auth.password
  env.OPENCODE_SERVER_USERNAME = auth.username
}

export function buildShuvcodeBasicAuthHeader(auth: ShuvcodeServerAuth) {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
}

export function persistShuvcodeServerAuth({
  dataDir,
  auth,
}: {
  dataDir: string
  auth: ShuvcodeServerAuth
}) {
  const filePath = getShuvcodeServerAuthFilePath({ dataDir })
  const written = errore.try(
    () => {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(filePath, `${JSON.stringify(auth)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      fs.chmodSync(filePath, 0o600)
    },
    (cause) =>
      new FilesystemOperationError({
        operation: 'persist shuvcode server auth',
        cause,
      }),
  )
  if (written instanceof Error) return written
  return true
}

export function loadShuvcodeServerAuth({ dataDir }: { dataDir: string }) {
  const filePath = getShuvcodeServerAuthFilePath({ dataDir })
  const raw = errore.try(
    () => fs.readFileSync(filePath, 'utf8'),
    () => null,
  )
  if (raw === null) return null
  const parsed = errore.try(
    () => JSON.parse(raw) as unknown,
    () => null,
  )
  if (parsed === null || !parsed || typeof parsed !== 'object') return null
  const record = parsed as { username?: unknown; password?: unknown }
  if (typeof record.password !== 'string' || record.password.length === 0) {
    return null
  }
  return {
    username:
      typeof record.username === 'string' && record.username.length > 0
        ? record.username
        : SHUVCODE_SERVER_USERNAME_DEFAULT,
    password: record.password,
  }
}

export function getShuvcodeServerAuthSnapshot({
  dataDir,
  env = process.env,
}: {
  dataDir: string
  env?: NodeJS.ProcessEnv
}) {
  return loadShuvcodeServerAuth({ dataDir }) || readShuvcodeServerAuthFromEnv({ env })
}

export function parseOpencodePortDiscovery(body: string) {
  const parsed = errore.try(
    () => JSON.parse(body) as unknown,
    (cause) =>
      new ShuvcodeAuthHandoffError({
        reason: 'invalid JSON from /kimaki/opencode-port',
        cause,
      }),
  )
  if (parsed instanceof Error) return parsed
  if (!parsed || typeof parsed !== 'object') {
    return new ShuvcodeAuthHandoffError({
      reason: 'opencode-port response is not an object',
    })
  }
  const record = parsed as {
    port?: unknown
    username?: unknown
    password?: unknown
  }
  if (typeof record.port !== 'number') {
    return new ShuvcodeAuthHandoffError({
      reason: 'opencode-port response missing port',
    })
  }
  return {
    port: record.port,
  }
}

export function buildOpencodePortDiscoveryPayload({ port }: { port: number }) {
  return { port }
}

export function isReusableShuvcodeHealthStatus(status: number) {
  if (status === 401 || status === 403) return false
  return status > 0 && status < 500
}

function requestJson({
  url,
  timeoutMs,
}: {
  url: string
  timeoutMs: number
}) {
  return new Promise<{ status: number; body: string } | FetchError>((resolve) => {
    const req = http.request(
      url,
      {
        method: 'GET',
        headers: { connection: 'close' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', (cause) => {
      resolve(new FetchError({ url, cause }))
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(new FetchError({ url, cause: new Error('timeout') }))
    })
    req.end()
  })
}

export async function fetchOpencodePortDiscovery({
  lockPort,
  timeoutMs = 2000,
}: {
  lockPort: number
  timeoutMs?: number
}) {
  const url = `http://127.0.0.1:${lockPort}/kimaki/opencode-port`
  const response = await requestJson({ url, timeoutMs })
  if (response instanceof Error) return response
  if (response.status !== 200) {
    return new ShuvcodeAuthHandoffError({
      reason: `/kimaki/opencode-port returned ${response.status}`,
    })
  }
  return parseOpencodePortDiscovery(response.body)
}

export async function resolveShuvcodeServerHandoff({
  lockPort,
  dataDir,
  env = process.env,
}: {
  lockPort: number
  dataDir: string
  env?: NodeJS.ProcessEnv
}) {
  const discovery = await fetchOpencodePortDiscovery({ lockPort })
  if (discovery instanceof Error) return discovery
  // Ignore any password field on the HTTP response. /kimaki/opencode-port
  // can be reached on 0.0.0.0 when the hrana server is internet-facing.
  // Prefer the data-dir file so `kimaki --data-dir B` does not reuse
  // OPENCODE_PASSWORD from another server's environment.
  const auth =
    loadShuvcodeServerAuth({ dataDir }) ||
    readShuvcodeServerAuthFromEnv({ env })
  if (!auth) {
    return new ShuvcodeAuthHandoffError({
      reason: 'no password in data-dir handoff file or env',
    })
  }
  return { port: discovery.port, auth }
}

function quotePosixAttachSegment(value: string) {
  if (!value) return "''"
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function quoteAttachCommandSegment({
  value,
  platform = process.platform,
}: {
  value: string
  platform?: NodeJS.Platform
}) {
  if (platform === 'win32') {
    return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`
  }
  return quotePosixAttachSegment(value)
}

export function buildKimakiAttachCommand({
  sessionId,
  directory,
  dataDir,
  platform = process.platform,
}: {
  sessionId: string
  directory: string
  dataDir?: string
  platform?: NodeJS.Platform
}) {
  const quote = (value: string) => quoteAttachCommandSegment({ value, platform })
  const parts = [
    'kimaki attach',
    '--session',
    sessionId,
    '--dir',
    quote(directory),
  ]
  if (dataDir && !isDefaultKimakiDataDir(dataDir)) {
    parts.push('--data-dir', quote(dataDir))
  }
  return parts.join(' ')
}

export function buildShuvcodeAttachArgs({
  serverUrl,
  sessionId,
  directory,
}: {
  serverUrl: string
  sessionId: string
  directory?: string
}) {
  if (!directory) {
    return ['--server', serverUrl, '--session', sessionId]
  }
  return ['--server', serverUrl, '--session', sessionId, directory]
}

export function buildShuvcodeAttachEnv({
  auth,
  env = process.env,
}: {
  auth: ShuvcodeServerAuth
  env?: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  return {
    ...env,
    OPENCODE_PASSWORD: auth.password,
    OPENCODE_SERVER_PASSWORD: auth.password,
    OPENCODE_SERVER_USERNAME: auth.username,
  }
}

export function buildKimakiAttachSpawn({
  resolvedCommand,
  serverUrl,
  sessionId,
  directory,
  auth,
  env = process.env,
  platform,
}: {
  resolvedCommand: string
  serverUrl: string
  sessionId: string
  directory: string
  auth: ShuvcodeServerAuth
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}) {
  // Keep the project directory off the cmd.exe command line. Windows npm
  // .cmd shims go through `cmd /c`, where `&`, `|`, `^`, and `%` in argv
  // are shell syntax. shuvcode uses cwd as the project directory.
  const spawned = getSpawnCommandAndArgs({
    resolvedCommand,
    baseArgs: buildShuvcodeAttachArgs({
      serverUrl,
      sessionId,
      directory: undefined,
    }),
    platform,
  })
  return {
    ...spawned,
    cwd: directory,
    env: buildShuvcodeAttachEnv({ auth, env }),
  }
}
