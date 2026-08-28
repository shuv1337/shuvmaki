import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  SHUVCODE_BIN_NAME,
  buildShuvcodeServeArgs,
  ensureShuvcodeServerPassword,
  getOpencodeServerAuthHeaders,
  getShuvcodeCandidatePaths,
  getShuvcodePathOverride,
  getShuvcodePathOverrideSource,
  isShuvcodeCliVersionOutput,
  looksLikeUpstreamOpencodeBinary,
} from './opencode.js'
import {
  buildShuvcodeSdkBaseUrl,
  isReusableShuvcodeHealthResponse,
  rewriteShuvcodePromptBody,
  rewriteShuvcodeRequestUrl,
  rewriteShuvcodeSessionCreateBody,
  toShuvcodeSdkBaseUrl,
  unwrapShuvcodeJsonBody,
} from './shuvcode-sdk-url.js'
import { translateShuvcodeEvent } from './shuvcode-event-adapter.js'

describe('shuvcode binary resolution helpers', () => {
  test('prefers SHUVCODE_PATH over OPENCODE_PATH', () => {
    expect(
      getShuvcodePathOverride({
        env: {
          SHUVCODE_PATH: '/opt/shuvcode',
          OPENCODE_PATH: '/opt/opencode',
        },
      }),
    ).toBe('/opt/shuvcode')
  })

  test('accepts OPENCODE_PATH when SHUVCODE_PATH is unset', () => {
    expect(
      getShuvcodePathOverride({
        env: {
          OPENCODE_PATH: '/opt/shuvcode',
        },
      }),
    ).toBe('/opt/shuvcode')
    expect(
      getShuvcodePathOverrideSource({
        env: {
          OPENCODE_PATH: '/opt/shuvcode',
        },
      }),
    ).toEqual({ path: '/opt/shuvcode', source: 'OPENCODE_PATH' })
  })

  test('records which env var supplied the override', () => {
    expect(
      getShuvcodePathOverrideSource({
        env: {
          SHUVCODE_PATH: '/opt/shuvcode',
          OPENCODE_PATH: '/opt/opencode',
        },
      }),
    ).toEqual({ path: '/opt/shuvcode', source: 'SHUVCODE_PATH' })
  })

  test('rejects upstream opencode binaries and non-shuvcode version output', () => {
    expect(looksLikeUpstreamOpencodeBinary('/usr/local/bin/opencode')).toBe(true)
    expect(looksLikeUpstreamOpencodeBinary('C:\\Program Files\\nodejs\\opencode.cmd')).toBe(
      true,
    )
    expect(looksLikeUpstreamOpencodeBinary('/usr/local/bin/shuvcode')).toBe(false)
    expect(isShuvcodeCliVersionOutput('shuvcode v2.0.0-alpha-16')).toBe(true)
    expect(isShuvcodeCliVersionOutput('opencode v1.18.3')).toBe(false)
  })

  test('ignores blank overrides', () => {
    expect(
      getShuvcodePathOverride({
        env: {
          SHUVCODE_PATH: '   ',
        },
      }),
    ).toBeUndefined()
  })

  test('unix candidate paths are shuvcode-only', () => {
    const home = '/home/user'
    const paths = getShuvcodeCandidatePaths({
      home,
      platform: 'linux',
    })
    expect(paths).toEqual([
      path.join(home, '.bun', 'bin', 'shuvcode'),
      path.join(home, '.local', 'bin', 'shuvcode'),
      path.join('/usr', 'local', 'bin', 'shuvcode'),
    ])
    expect(paths.some((candidate) => candidate.includes('opencode'))).toBe(false)
  })

  test('windows candidate paths are shuvcode-only', () => {
    const home = 'C:\\Users\\user'
    const paths = getShuvcodeCandidatePaths({
      home,
      platform: 'win32',
    })
    expect(paths).toEqual([
      path.join(home, '.local', 'bin', 'shuvcode.exe'),
      path.join(home, '.bun', 'bin', 'shuvcode.exe'),
      path.join(home, 'AppData', 'Roaming', 'npm', 'shuvcode.cmd'),
    ])
    expect(paths.some((candidate) => candidate.includes('opencode'))).toBe(false)
  })

  test('serve args are only the v2-safe port pair', () => {
    expect(buildShuvcodeServeArgs({ port: 4096 })).toEqual([
      'serve',
      '--port',
      '4096',
    ])
    expect(buildShuvcodeServeArgs({ port: 4096 }).join(' ')).not.toContain(
      'print-logs',
    )
    expect(buildShuvcodeServeArgs({ port: 4096 }).join(' ')).not.toContain(
      'log-level',
    )
  })

  test('generates a shared server password when none is set', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-auth-'))
    const env: NodeJS.ProcessEnv = {}
    const password = ensureShuvcodeServerPassword({ env, dataDir })
    expect(password.length).toBeGreaterThan(16)
    expect(env.OPENCODE_PASSWORD).toBe(password)
    expect(env.OPENCODE_SERVER_PASSWORD).toBe(password)
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('reuses OPENCODE_PASSWORD when already set', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-auth-'))
    const env: NodeJS.ProcessEnv = { OPENCODE_PASSWORD: 'existing-secret' }
    expect(ensureShuvcodeServerPassword({ env, dataDir })).toBe('existing-secret')
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('existing-secret')
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('auth headers prefer the data-dir file over env', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-auth-'))
    ensureShuvcodeServerPassword({
      env: { OPENCODE_PASSWORD: 'file-secret' },
      dataDir,
    })
    expect(
      getOpencodeServerAuthHeaders({
        dataDir,
        env: {
          OPENCODE_PASSWORD: 'env-secret',
          OPENCODE_SERVER_PASSWORD: 'env-secret',
        },
      }),
    ).toEqual({
      Authorization: `Basic ${Buffer.from('opencode:file-secret').toString('base64')}`,
    })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('binary name is shuvcode', () => {
    expect(SHUVCODE_BIN_NAME).toBe('shuvcode')
  })

  test('SDK baseUrl is the /api origin and is idempotent', () => {
    expect(buildShuvcodeSdkBaseUrl({ port: 4096 })).toBe('http://127.0.0.1:4096/api')
    expect(toShuvcodeSdkBaseUrl('http://127.0.0.1:4096')).toBe(
      'http://127.0.0.1:4096/api',
    )
    expect(toShuvcodeSdkBaseUrl('http://127.0.0.1:4096/api')).toBe(
      'http://127.0.0.1:4096/api',
    )
    expect(toShuvcodeSdkBaseUrl('http://127.0.0.1:4096/api/')).toBe(
      'http://127.0.0.1:4096/api',
    )
    expect(
      isReusableShuvcodeHealthResponse({
        status: 200,
        contentType: 'text/html; charset=utf-8',
      }),
    ).toBe(false)
    expect(
      rewriteShuvcodeSessionCreateBody({
        body: {
          directory: '/tmp/project',
          permission: [{ permission: 'bash', action: 'allow', pattern: '*' }],
          title: 'hello',
        },
        directory: '/tmp/project',
      }),
    ).toEqual({
      title: 'hello',
      location: { directory: '/tmp/project' },
    })
    expect(
      rewriteShuvcodePromptBody({
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
        messageID: 'msg_1',
        agent: 'plan',
      }),
    ).toEqual({
      text: 'hello\nworld',
      id: 'msg_1',
      agents: [{ name: 'plan' }],
    })
    expect(
      rewriteShuvcodeRequestUrl(
        new URL('http://127.0.0.1:4096/api/session/ses_1/prompt_async'),
      ).pathname,
    ).toBe('/api/session/ses_1/prompt')
    expect(
      rewriteShuvcodeRequestUrl(
        new URL('http://127.0.0.1:4096/api/session/ses_1/abort'),
      ).pathname,
    ).toBe('/api/session/ses_1/interrupt')
    expect(unwrapShuvcodeJsonBody({ data: { id: 'ses_1' } })).toEqual({
      id: 'ses_1',
    })
    expect(
      translateShuvcodeEvent({
        type: 'session.text.ended',
        data: {
          sessionID: 'ses_1',
          assistantMessageID: 'msg_a',
          ordinal: 0,
          text: 'hi',
        },
      }),
    ).toEqual([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: {
            id: 'text-ses_1-msg_a-0',
            sessionID: 'ses_1',
            messageID: 'msg_a',
            type: 'text',
            text: 'hi',
            time: { start: expect.any(Number), end: expect.any(Number) },
          },
        },
      },
    ])
  })
})
