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
  readShuvcodePromptModel,
  rewriteShuvcodePromptBody,
  rewriteShuvcodeRequestUrl,
  rewriteShuvcodeSessionCreateBody,
  toShuvcodeSdkBaseUrl,
  unwrapShuvcodeJsonBody,
} from './shuvcode-sdk-url.js'
import {
  createShuvcodeEventTranslateState,
  translateShuvcodeEvent,
} from './shuvcode-event-adapter.js'

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
      policy: { tools: { allow: ['bash'] } },
    })
    expect(
      rewriteShuvcodePromptBody({
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
        messageID: 'msg_1',
        agent: 'plan',
        system: 'you are kimaki',
        model: { providerID: 'anthropic', modelID: 'claude' },
        variant: 'high',
        noReply: true,
      }),
    ).toEqual({
      text: 'hello\nworld',
      id: 'msg_1',
      agents: [{ name: 'plan' }],
      metadata: {
        system: 'you are kimaki',
        model: { providerID: 'anthropic', modelID: 'claude' },
        variant: 'high',
        noReply: true,
      },
      resume: false,
    })
    expect(
      readShuvcodePromptModel({
        model: { providerID: 'anthropic', modelID: 'claude' },
        variant: 'high',
      }),
    ).toEqual({
      id: 'claude',
      providerID: 'anthropic',
      variant: 'high',
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
    expect(
      rewriteShuvcodeRequestUrl(
        new URL('http://127.0.0.1:4096/api/session/ses_1/revert'),
      ).pathname,
    ).toBe('/api/session/ses_1/revert/stage')
    expect(
      rewriteShuvcodeRequestUrl(
        new URL('http://127.0.0.1:4096/api/session/ses_1/unrevert'),
      ).pathname,
    ).toBe('/api/session/ses_1/revert/clear')
    expect(
      rewriteShuvcodeRequestUrl(
        new URL('http://127.0.0.1:4096/api/session/ses_1/summarize'),
      ).pathname,
    ).toBe('/api/session/ses_1/compact')
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
    const state = createShuvcodeEventTranslateState()
    expect(
      translateShuvcodeEvent(
        {
          type: 'session.inbox.enqueued',
          created: 10,
          data: {
            sessionID: 'ses_1',
            inboxID: 'msg_user',
            item: { type: 'user', payload: { text: 'hi', agents: [{ name: 'build' }] } },
          },
        },
        state,
      ),
    ).toEqual([
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_user',
            sessionID: 'ses_1',
            role: 'user',
            time: { created: 10 },
            agent: 'build',
          },
        },
      },
    ])
    const stepEvents = translateShuvcodeEvent(
      {
        type: 'session.step.started',
        created: 11,
        data: {
          sessionID: 'ses_1',
          assistantMessageID: 'msg_a',
          agent: 'build',
          model: { id: 'claude', providerID: 'anthropic' },
        },
      },
      state,
    )
    expect(stepEvents[0]).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_a',
          sessionID: 'ses_1',
          role: 'assistant',
          parentID: 'msg_user',
          modelID: 'claude',
          providerID: 'anthropic',
          mode: 'build',
          agent: 'build',
          time: { created: 11 },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    })
    expect(
      translateShuvcodeEvent(
        {
          type: 'session.step.ended',
          created: 12,
          data: {
            sessionID: 'ses_1',
            assistantMessageID: 'msg_a',
            finish: 'stop',
            tokens: {
              input: 1,
              output: 2,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        },
        state,
      ),
    ).toEqual([
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_a',
            sessionID: 'ses_1',
            role: 'assistant',
            parentID: 'msg_user',
            modelID: 'claude',
            providerID: 'anthropic',
            mode: 'build',
            agent: 'build',
            time: { created: 12, completed: 12 },
            cost: 0,
            tokens: {
              input: 1,
              output: 2,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish: 'stop',
          },
        },
      },
    ])
  })
})
