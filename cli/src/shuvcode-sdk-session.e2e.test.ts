// Spawns a real shuvcode serve process and creates a session through the
// published @opencode-ai/sdk/v2 client. This is the cutover contract: the
// SDK emits unprefixed routes (`/session`), so baseUrl must include `/api`.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { afterAll, expect, test } from 'vitest'
import { buildShuvcodeServeArgs, resolveOpencodeCommand } from './opencode.js'
import { getSpawnCommandAndArgs } from './opencode-command.js'
import {
  buildShuvcodeBasicAuthHeader,
  type ShuvcodeServerAuth,
} from './shuvcode-server-auth.js'
import {
  buildShuvcodeOriginUrl,
  buildShuvcodeSdkBaseUrl,
  createShuvcodeSdkFetch,
  isReusableShuvcodeHealthResponse,
  rewriteShuvcodeSdkRequest,
} from './shuvcode-sdk-url.js'
import { chooseLockPort } from './test-utils.js'

const projectDir = path.resolve(process.cwd(), 'tmp', 'shuvcode-sdk-session-e2e')
const serveAuth: ShuvcodeServerAuth = {
  username: 'opencode',
  password: 'sdk-session-e2e-secret',
}

let serverProcess: ChildProcess | undefined

async function waitForJsonHealth({
  port,
  authorization,
  maxAttempts = 30,
}: {
  port: number
  authorization: string
  maxAttempts?: number
}): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: authorization },
    }).catch(() => null)
    if (
      response &&
      isReusableShuvcodeHealthResponse({
        status: response.status,
        contentType: response.headers.get('content-type'),
      })
    ) {
      return true
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
  }
  return false
}

afterAll(() => {
  serverProcess?.kill('SIGTERM')
})

test(
  'SDK session.create succeeds against a real shuvcode serve on /api',
  async () => {
    fs.mkdirSync(projectDir, { recursive: true })
    const port = chooseLockPort({ key: 'shuvcode-sdk-session-e2e' })
    const { command, args, windowsVerbatimArguments } = getSpawnCommandAndArgs({
      resolvedCommand: resolveOpencodeCommand(),
      baseArgs: buildShuvcodeServeArgs({ port }),
    })

    serverProcess = spawn(command, args, {
      stdio: 'pipe',
      cwd: projectDir,
      windowsVerbatimArguments,
      env: {
        ...process.env,
        OPENCODE_PASSWORD: serveAuth.password,
        OPENCODE_SERVER_PASSWORD: serveAuth.password,
        OPENCODE_SERVER_USERNAME: serveAuth.username,
      },
    })

    const healthy = await waitForJsonHealth({
      port,
      authorization: buildShuvcodeBasicAuthHeader(serveAuth),
    })
    expect(healthy).toBe(true)

    const unprefixed = await fetch(`${buildShuvcodeOriginUrl({ port })}/session`, {
      method: 'POST',
      headers: {
        Authorization: buildShuvcodeBasicAuthHeader(serveAuth),
        'content-type': 'application/json',
      },
      body: '{}',
    })
    expect(unprefixed.status).toBe(405)

    const htmlFallback = await fetch(`${buildShuvcodeOriginUrl({ port })}/session`, {
      headers: { Authorization: buildShuvcodeBasicAuthHeader(serveAuth) },
    })
    expect(
      isReusableShuvcodeHealthResponse({
        status: htmlFallback.status,
        contentType: htmlFallback.headers.get('content-type'),
      }),
    ).toBe(false)

    const client = createOpencodeClient({
      baseUrl: buildShuvcodeSdkBaseUrl({ port }),
      directory: projectDir,
      headers: {
        Authorization: buildShuvcodeBasicAuthHeader(serveAuth),
      },
      fetch: createShuvcodeSdkFetch(),
    })
    const created = await client.session.create({
      directory: projectDir,
      title: 'shuvcode-sdk-session-e2e',
      permission: [{ permission: 'bash', action: 'allow', pattern: '*' }],
    })
    expect(created.error).toBeUndefined()
    expect(created.data?.id).toMatch(/^ses_/)

    const denied = await rewriteShuvcodeSdkRequest(
      new Request(`${buildShuvcodeSdkBaseUrl({ port })}/session`, {
        method: 'POST',
        headers: {
          Authorization: buildShuvcodeBasicAuthHeader(serveAuth),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          directory: projectDir,
          permission: [
            { permission: 'external_directory', action: 'deny', pattern: '/repo' },
          ],
        }),
      }),
    )
    expect(denied).toBeInstanceOf(Response)
    expect((denied as Response).status).toBe(422)

    const providers = await client.provider.list({ directory: projectDir })
    expect(created.error).toBeUndefined()
    expect(Array.isArray(providers.data?.all)).toBe(true)
    expect(Array.isArray(providers.data?.connected)).toBe(true)

    if (typeof client.session.promptAsync === 'function') {
      const prompt = await client.session.promptAsync({
        sessionID: created.data!.id,
        directory: projectDir,
        parts: [{ type: 'text', text: 'context only, do not reply' }],
        noReply: true,
      })
      expect(prompt.error).toBeUndefined()
      const status = await client.session.status({ directory: projectDir })
      const sessionStatus = status.data?.[created.data!.id]
      expect(!sessionStatus || sessionStatus.type === 'idle').toBe(true)
    }
  },
  60_000,
)
