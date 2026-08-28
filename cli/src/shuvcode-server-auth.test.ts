import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { setDataDir } from './config.js'
import { buildSessionIdAttachReply } from './commands/session-id.js'
import {
  applyShuvcodeServerAuth,
  attachCommandHasUnescapableCmdPercent,
  buildKimakiAttachCommand,
  buildKimakiAttachSpawn,
  buildOpencodePortDiscoveryPayload,
  buildShuvcodeAttachArgs,
  buildShuvcodeAttachEnv,
  buildShuvcodeBasicAuthHeader,
  isReusableShuvcodeHealthStatus,
  loadShuvcodeServerAuth,
  parseOpencodePortDiscovery,
  persistShuvcodeServerAuth,
  resolveShuvcodeServerHandoff,
} from './shuvcode-server-auth.js'

const tempDirs: string[] = []

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-auth-handoff-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function listen({
  handler,
}: {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
}) {
  return new Promise<{ server: http.Server; port: number }>((resolve, reject) => {
    const server = http.createServer(handler)
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('server missing port'))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

describe('shuvcode server auth handoff', () => {
  test('persists and reloads a 0600 auth file', () => {
    const dataDir = makeTempDir()
    const persisted = persistShuvcodeServerAuth({
      dataDir,
      auth: { username: 'opencode', password: 'handoff-secret' },
    })
    expect(persisted).toBe(true)
    const filePath = path.join(dataDir, 'shuvcode-server-auth.json')
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
    expect(loadShuvcodeServerAuth({ dataDir })).toEqual({
      username: 'opencode',
      password: 'handoff-secret',
    })
  })

  test('parseOpencodePortDiscovery requires a numeric port and drops credentials', () => {
    expect(buildOpencodePortDiscoveryPayload({ port: 4096 })).toEqual({ port: 4096 })
    expect(Object.keys(buildOpencodePortDiscoveryPayload({ port: 4096 }))).toEqual([
      'port',
    ])
    const parsed = parseOpencodePortDiscovery(
      JSON.stringify({ port: 4096, username: 'opencode', password: 'secret' }),
    )
    expect(parsed).toEqual({
      port: 4096,
    })
    expect(parseOpencodePortDiscovery('{"port":"4096"}')).toBeInstanceOf(Error)
  })

  test('401 and 403 health responses are not reusable', () => {
    expect(isReusableShuvcodeHealthStatus(200)).toBe(true)
    expect(isReusableShuvcodeHealthStatus(401)).toBe(false)
    expect(isReusableShuvcodeHealthStatus(403)).toBe(false)
    expect(isReusableShuvcodeHealthStatus(500)).toBe(false)
  })

  test('kimaki attach command never includes the serve password', () => {
    const command = buildKimakiAttachCommand({
      sessionId: 'ses_test',
      directory: "/tmp/it's a dir",
      dataDir: '/tmp/kimaki-custom',
      platform: 'linux',
    })
    expect(command).toBe(
      "kimaki attach --session ses_test --dir '/tmp/it'\"'\"'s a dir' --data-dir '/tmp/kimaki-custom'",
    )
    expect(command).not.toContain('OPENCODE_')
    expect(command).not.toContain('password')
    expect(buildSessionIdAttachReply({
      sessionId: 'ses_test',
      directory: '/tmp/project',
      dataDir: '/tmp/kimaki-custom',
      platform: 'linux',
    })).toMatchInlineSnapshot(`
      "**Session ID:** \`ses_test\`
      **Attach command:**
      \`\`\`bash
      kimaki attach --session ses_test --dir '/tmp/project' --data-dir '/tmp/kimaki-custom'
      \`\`\`"
    `)
    expect(
      buildKimakiAttachCommand({
        sessionId: 'ses_test',
        directory: 'C:\\proj\\foo&bar|%USERNAME%',
        dataDir: 'C:\\kimaki-custom',
        platform: 'win32',
      }),
    ).toBe(
      'kimaki attach --session ses_test --dir "C:\\proj\\foo&bar|%USERNAME%" --data-dir "C:\\kimaki-custom"',
    )
    expect(
      attachCommandHasUnescapableCmdPercent({
        directory: 'C:\\proj\\foo&bar|%USERNAME%',
        dataDir: 'C:\\kimaki-custom',
        platform: 'win32',
      }),
    ).toBe(true)
    expect(
      buildSessionIdAttachReply({
        sessionId: 'ses_test',
        directory: 'C:\\proj\\foo%bar',
        dataDir: 'C:\\kimaki-custom',
        platform: 'win32',
      }),
    ).toContain('Run the command in PowerShell')
  })

  test('attach spawn args and env keep the secret out of argv', () => {
    const auth = { username: 'opencode', password: 'never-on-argv' }
    applyShuvcodeServerAuth({ auth, env: {} })
    expect(buildShuvcodeAttachArgs({
      serverUrl: 'http://127.0.0.1:4096',
      sessionId: 'ses_test',
      directory: '/tmp/project',
    })).toEqual([
      '--server',
      'http://127.0.0.1:4096',
      '--session',
      'ses_test',
      '/tmp/project',
    ])
    const env = buildShuvcodeAttachEnv({ auth, env: { PATH: '/bin' } })
    expect(env.OPENCODE_PASSWORD).toBe('never-on-argv')
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('never-on-argv')
    expect(buildShuvcodeBasicAuthHeader(auth)).toBe(
      `Basic ${Buffer.from('opencode:never-on-argv').toString('base64')}`,
    )
    const windowsSpawn = buildKimakiAttachSpawn({
      resolvedCommand: 'C:\\Program Files\\nodejs\\shuvcode.cmd',
      serverUrl: 'http://127.0.0.1:4096',
      sessionId: 'ses_test',
      directory: 'C:\\Users\\user\\project',
      auth,
      env: { PATH: '/bin' },
      platform: 'win32',
    })
    expect(windowsSpawn.windowsVerbatimArguments).toBe(true)
    expect(windowsSpawn.command).toBe('cmd.exe')
    expect(windowsSpawn.cwd).toBe('C:\\Users\\user\\project')
    expect(windowsSpawn.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\Program Files\\nodejs\\shuvcode.cmd"',
      '"--server"',
      '"http://127.0.0.1:4096"',
      '"--session"',
      '"ses_test"',
    ])
    expect(windowsSpawn.args.join(' ')).not.toContain('project')
  })

  test('resolveShuvcodeServerHandoff prefers the data-dir file over env', async () => {
    const dataDir = makeTempDir()
    persistShuvcodeServerAuth({
      dataDir,
      auth: { username: 'opencode', password: 'data-dir-secret' },
    })
    const lock = await listen({
      handler: (req, res) => {
        if (req.url === '/kimaki/opencode-port') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ port: 4096 }))
          return
        }
        res.writeHead(404)
        res.end()
      },
    })
    try {
      const handoff = await resolveShuvcodeServerHandoff({
        lockPort: lock.port,
        dataDir,
        env: {
          OPENCODE_PASSWORD: 'env-from-other-server',
          OPENCODE_SERVER_PASSWORD: 'env-from-other-server',
        },
      })
      expect(handoff).toEqual({
        port: 4096,
        auth: { username: 'opencode', password: 'data-dir-secret' },
      })
      expect(loadShuvcodeServerAuth({ dataDir })?.password).toBe('data-dir-secret')
    } finally {
      lock.server.close()
    }
  })

  test('resolveShuvcodeServerHandoff uses the data-dir file and ignores HTTP passwords', async () => {
    const dataDir = makeTempDir()
    const password = 'lock-port-secret'
    const username = 'opencode'
    persistShuvcodeServerAuth({
      dataDir,
      auth: { username, password },
    })

    const shuvcode = await listen({
      handler: (_req, res) => {
        res.writeHead(404)
        res.end()
      },
    })
    const lock = await listen({
      handler: (req, res) => {
        if (req.url === '/kimaki/opencode-port') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            port: shuvcode.port,
            username: 'attacker',
            password: 'injected-from-http',
          }))
          return
        }
        res.writeHead(404)
        res.end()
      },
    })

    try {
      const handoff = await resolveShuvcodeServerHandoff({
        lockPort: lock.port,
        dataDir,
        env: {},
      })
      expect(handoff).toEqual({
        port: shuvcode.port,
        auth: { username, password },
      })
    } finally {
      shuvcode.server.close()
      lock.server.close()
    }
  })

  test('separate process reuses a password-protected server via lock-port discovery', async () => {
    const dataDir = makeTempDir()
    setDataDir(dataDir)
    const password = 'child-process-secret'
    const username = 'opencode'
    persistShuvcodeServerAuth({
      dataDir,
      auth: { username, password },
    })
    const expectedAuth = Buffer.from(`${username}:${password}`).toString('base64')

    const shuvcode = await listen({
      handler: (req, res) => {
        if (req.url?.startsWith('/api/health')) {
          if (req.headers.authorization === `Basic ${expectedAuth}`) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ healthy: true }))
            return
          }
          res.writeHead(401)
          res.end()
          return
        }
        res.writeHead(404)
        res.end()
      },
    })
    const lock = await listen({
      handler: (req, res) => {
        if (req.url === '/kimaki/opencode-port') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            port: shuvcode.port,
          }))
          return
        }
        res.writeHead(404)
        res.end()
      },
    })

    const childPath = fileURLToPath(
      new URL('./shuvcode-server-auth-child.ts', import.meta.url),
    )
    const childEnv = { ...process.env }
    delete childEnv.OPENCODE_PASSWORD
    delete childEnv.OPENCODE_SERVER_PASSWORD
    delete childEnv.OPENCODE_SERVER_USERNAME
    childEnv.KIMAKI_LOCK_PORT = String(lock.port)
    childEnv.KIMAKI_TEST_DATA_DIR = dataDir

    try {
      const result = await new Promise<{
        code: number | null
        stdout: string
        stderr: string
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', childPath],
          {
            cwd: path.dirname(childPath),
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })
        child.on('error', reject)
        child.on('exit', (code) => resolve({ code, stdout, stderr }))
      })

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        port: shuvcode.port,
        status: 200,
      })
    } finally {
      shuvcode.server.close()
      lock.server.close()
    }
  }, 20_000)
})
