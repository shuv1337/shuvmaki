import fs from 'node:fs'
import path from 'node:path'
import { createOpencode } from '@opencode-ai/sdk/v2'
import { expect, test } from 'vitest'
import { CachedOpencodeProviderProxy } from './cached-opencode-provider-proxy.js'

const geminiApiKey =
  process.env['GEMINI_API_KEY'] ||
  process.env['GOOGLE_GENERATIVE_AI_API_KEY'] ||
  ''
const geminiModel = process.env['GEMINI_FLASH_MODEL'] || 'gemini-2.5-flash'

type SdkResult<T> =
  | T
  | {
      data?: T
      error?: unknown
    }

function createProjectDirectory() {
  const projectDirectory = path.resolve(
    process.cwd(),
    'tmp',
    'cached-opencode-provider-test-project',
  )
  fs.mkdirSync(projectDirectory, { recursive: true })
  return projectDirectory
}

function extractData<T>({ result }: { result: SdkResult<T> }) {
  if (!result || typeof result !== 'object') {
    return result as T
  }
  const hasDataField = 'data' in result
  if (!hasDataField) {
    return result as T
  }
  const maybeRecord = result as { data?: T }
  return maybeRecord.data as T
}

function extractError({ result }: { result: unknown }) {
  if (!result || typeof result !== 'object') {
    return null
  }
  if (!('error' in result)) {
    return null
  }
  const maybeRecord = result as { error?: unknown }
  return maybeRecord.error || null
}

function errorMessage({ error }: { error: unknown }) {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return JSON.stringify(error)
}

async function waitFor({
  check,
  timeoutMs,
  intervalMs,
  message,
}: {
  check: () => Promise<boolean>
  timeoutMs: number
  intervalMs: number
  message: string
}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const ready = await check()
    if (ready) {
      return
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs)
    })
  }
  throw new Error(message)
}

async function runPrompt({
  client,
  directory,
  prompt,
}: {
  client: Awaited<ReturnType<typeof createOpencode>>['client']
  directory: string
  prompt: string
}) {
  const created = await client.session.create({
    directory,
    title: 'cached-provider-test',
  })
  const createError = extractError({ result: created })
  if (createError) {
    throw new Error(`session.create failed: ${errorMessage({ error: createError })}`)
  }
  const session = extractData<{ id: string }>({
    result: created as SdkResult<{ id: string }>,
  })
  if (!session?.id) {
    throw new Error('session.create returned no session id')
  }

  const promptResult = await client.session.prompt({
    sessionID: session.id,
    directory,
    system: 'Reply with a short single-line answer.',
    parts: [
      {
        type: 'text',
        text: prompt,
      },
    ],
  })
  const promptError = extractError({ result: promptResult })
  if (promptError) {
    throw new Error(
      `session.prompt failed: ${errorMessage({ error: promptError })}`,
    )
  }
}

const testWithGemini = geminiApiKey ? test : test.skip

testWithGemini(
  'proxies Gemini through opencode config and serves cached responses',
  async () => {
    const projectDirectory = createProjectDirectory()
    const cacheDbPath = path.join(projectDirectory, 'provider-cache.db')
    const proxy = new CachedOpencodeProviderProxy({
      cacheDbPath,
      targetBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: geminiApiKey,
      cacheMethods: ['POST'],
    })

    let opencodeServer: Awaited<ReturnType<typeof createOpencode>> | null = null
    try {
      await proxy.start()

      const opencodeConfig = proxy.buildOpencodeConfig({
        providerName: 'cached-google',
        providerNpm: '@ai-sdk/google',
        model: geminiModel,
        smallModel: geminiModel,
      })
      fs.writeFileSync(
        path.join(projectDirectory, 'opencode.json'),
        JSON.stringify(opencodeConfig, null, 2),
      )

      opencodeServer = await createOpencode()

      const prompt = 'Say exactly: cache-proxy-test'
      await runPrompt({
        client: opencodeServer.client,
        directory: projectDirectory,
        prompt,
      })

      await waitFor({
        timeoutMs: 30_000,
        intervalMs: 250,
        message: 'expected first cache entry to be persisted',
        check: async () => {
          const count = await proxy.getCacheEntryCount()
          return count > 0
        },
      })

      const latestRequest = await proxy.getLatestCachedRequest()
      if (!latestRequest) {
        throw new Error('expected a cached request row after first prompt')
      }

      await fetch(
        new URL(latestRequest.endpoint, proxy.baseUrl),
        {
          method: latestRequest.method,
          headers: {
            'content-type': 'application/json',
          },
          body: latestRequest.requestBody,
        },
      )

      await waitFor({
        timeoutMs: 10_000,
        intervalMs: 100,
        message: 'expected at least one cache hit after replaying cached request',
        check: async () => {
          return proxy.stats.cacheHits > 0
        },
      })

      expect(proxy.stats.cacheHits).toBeGreaterThan(0)
      expect(await proxy.getCacheEntryCount()).toBeGreaterThan(0)
    } finally {
      if (opencodeServer) {
        opencodeServer.server.close()
      }
      await proxy.stop()
    }
  },
  240_000,
)
