// Local caching proxy for OpenCode provider HTTP traffic.
// Proxies provider requests (Anthropic-compatible by default) and stores
// responses in a local libsql-backed SQLite cache for deterministic replays.

import { createClient, type Client } from '@libsql/client'
import { createParser } from 'eventsource-parser'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { Spiceflow } from 'spiceflow'

const CACHE_TABLE = 'cached_provider_responses'
const DEFAULT_TARGET_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_HOST = '127.0.0.1'
const HOP_BY_HOP_HEADERS: Set<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

export type CachedOpencodeProviderProxyOptions = {
  cacheDbPath?: string
  targetBaseUrl?: string
  listenHost?: string
  listenPort?: number
  cacheMethods?: string[]
  apiKey?: string
  authorization?: string
  upstreamApiKey?: string
  upstreamApiKeyHeader?: string
  upstreamAuthorization?: string
  additionalHeaders?: Record<string, string>
  /** Delay in ms between SSE chunks when replaying cached streaming responses.
   *  0 = instant replay (default). Only affects cache hits with text/event-stream. */
  streamChunkDelayMs?: number
}

export type CachedOpencodeProviderConfigOptions = {
  model: string
  smallModel?: string
  providerName?: string
  providerNpm?: string
}

type CacheLookupResult = {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

type ParsedCacheRow = {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

type LatestCachedRequest = {
  endpoint: string
  method: string
  requestBody: string
}

export class CachedOpencodeProviderProxy {
  private readonly cacheDbPath: string
  private readonly targetBaseUrl: string
  private readonly listenHost: string
  private readonly listenPort: number
  private readonly cacheMethods: Set<string>
  private readonly apiKey: string | undefined
  private readonly authorization: string | undefined
  private readonly upstreamApiKey: string | undefined
  private readonly upstreamApiKeyHeader: string | undefined
  private readonly upstreamAuthorization: string | undefined
  private readonly additionalHeaders: Record<string, string>
  private readonly app: Spiceflow

  private database: Client | null = null
  private server: http.Server | null = null
  private runningPort: number | null = null
  private cacheHits = 0
  private cacheMisses = 0
  private streamChunkDelayMs: number

  constructor({
    cacheDbPath,
    targetBaseUrl,
    listenHost,
    listenPort,
    cacheMethods,
    apiKey,
    authorization,
    upstreamApiKey,
    upstreamApiKeyHeader,
    upstreamAuthorization,
    additionalHeaders,
    streamChunkDelayMs,
  }: CachedOpencodeProviderProxyOptions = {}) {
    this.cacheDbPath =
      cacheDbPath ||
      path.resolve(process.cwd(), 'tmp', 'opencode-provider-cache.db')
    this.targetBaseUrl = targetBaseUrl || DEFAULT_TARGET_BASE_URL
    this.listenHost = listenHost || DEFAULT_HOST
    this.listenPort = listenPort || 0
    this.cacheMethods = new Set((cacheMethods || ['POST']).map((method) => {
      return method.toUpperCase()
    }))
    this.apiKey = apiKey
    this.authorization = authorization
    this.upstreamApiKey = upstreamApiKey
    this.upstreamApiKeyHeader = upstreamApiKeyHeader
    this.upstreamAuthorization = upstreamAuthorization
    this.additionalHeaders = additionalHeaders || {}
    this.streamChunkDelayMs = streamChunkDelayMs || 0
    this.app = new Spiceflow().use(async ({ request }) => {
      return this.handleRequest({ request })
    })
  }

  /** Change the SSE chunk delay at runtime (e.g. between test steps). */
  setStreamChunkDelayMs(ms: number) {
    this.streamChunkDelayMs = ms
  }

  get port(): number | null {
    return this.runningPort
  }

  get baseUrl(): string {
    const port = this.runningPort
    if (!port) {
      return ''
    }
    return `http://${this.listenHost}:${port}`
  }

  get isRunning(): boolean {
    return this.server !== null && this.runningPort !== null
  }

  get stats() {
    return {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
    }
  }

  async getCacheEntryCount() {
    await this.ensureDatabaseReady()
    const database = this.database
    if (!database) {
      return 0
    }
    const result = await database.execute(`
      SELECT COUNT(*) AS total
      FROM ${CACHE_TABLE}
    `)
    const total = result.rows[0]?.['total']
    if (typeof total === 'number') {
      return total
    }
    if (typeof total === 'bigint') {
      return Number(total)
    }
    if (typeof total === 'string') {
      const parsed = Number(total)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
    return 0
  }

  async getLatestCachedRequest() {
    await this.ensureDatabaseReady()
    const database = this.database
    if (!database) {
      return null
    }
    const result = await database.execute(`
      SELECT endpoint, method, request_body
      FROM ${CACHE_TABLE}
      ORDER BY created_at DESC
      LIMIT 1
    `)
    const firstRow = result.rows[0]
    if (!firstRow) {
      return null
    }
    const endpoint = firstRow['endpoint']
    const method = firstRow['method']
    const requestBody = firstRow['request_body']
    if (
      typeof endpoint !== 'string' ||
      typeof method !== 'string' ||
      typeof requestBody !== 'string'
    ) {
      return null
    }
    const latest: LatestCachedRequest = {
      endpoint,
      method,
      requestBody,
    }
    return latest
  }

  async start() {
    if (this.isRunning) {
      return
    }
    await this.ensureDatabaseReady()
    const server = http.createServer((req, res) => {
      return this.app.handleForNode(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.listenPort, this.listenHost, () => {
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Could not resolve proxy listen port')
    }
    this.server = server
    this.runningPort = address.port
  }

  async stop() {
    const server = this.server
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    }
    this.server = null
    this.runningPort = null
    if (this.database) {
      this.database.close()
    }
    this.database = null
  }

  buildOpencodeConfig({
    model,
    smallModel,
    providerName,
    providerNpm,
  }: CachedOpencodeProviderConfigOptions) {
    const chosenProviderName = providerName || 'cached-provider'
    const chosenProviderNpm = providerNpm || '@ai-sdk/anthropic'
    if (!this.baseUrl) {
      throw new Error('Proxy must be started before building OpenCode config')
    }
    return {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [chosenProviderName]: {
          npm: chosenProviderNpm,
          name: 'Cached Provider Proxy',
          options: {
            baseURL: this.baseUrl,
            ...(this.apiKey && { apiKey: this.apiKey }),
          },
          models: {
            [model]: {
              name: model,
            },
            ...(smallModel
              ? {
                  [smallModel]: {
                    name: smallModel,
                  },
                }
              : {}),
          },
        },
      },
      model: `${chosenProviderName}/${model}`,
      ...(smallModel && {
        small_model: `${chosenProviderName}/${smallModel}`,
      }),
    }
  }

  private async handleRequest({ request }: { request: Request }) {
    const url = new URL(request.url)
    // Concatenate base URL + incoming path to preserve base path prefixes
    // like /v1beta. new URL(absolutePath, base) would drop the base path
    // because an absolute path (starting with /) replaces the entire path.
    const targetUrl = new URL(
      this.targetBaseUrl.replace(/\/$/, '') + url.pathname + url.search,
    )

    const shouldUseCache = this.cacheMethods.has(request.method.toUpperCase())

    if (!shouldUseCache) {
      const upstream = await this.forwardRequest({ request, targetUrl })
      return upstream
    }

    const requestText = await request.clone().text()
    const parsedRequestBody = this.tryParseJson({ text: requestText })
    const cacheKey = this.computeCacheKey({
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      body: parsedRequestBody,
      anthropicVersion: request.headers.get('anthropic-version') || '',
      anthropicBeta: request.headers.get('anthropic-beta') || '',
    })

    const cacheEntry = await this.lookupCache({ cacheKey })
    if (cacheEntry) {
      this.cacheHits += 1
      const isSSE = (cacheEntry.headers['content-type'] || '').includes('text/event-stream')
      if (isSSE && this.streamChunkDelayMs > 0) {
        return new Response(
          this.createDelayedSSEStream({
            body: cacheEntry.body,
            delayMs: this.streamChunkDelayMs,
          }),
          {
            status: cacheEntry.status,
            headers: cacheEntry.headers,
          },
        )
      }
      return new Response(cacheEntry.body, {
        status: cacheEntry.status,
        headers: cacheEntry.headers,
      })
    }
    this.cacheMisses += 1

    const upstream = await this.forwardRequest({ request, targetUrl })
    const upstreamHeaders = this.serializeResponseHeaders({
      headers: upstream.headers,
    })

    // Store proxy-local path as endpoint (not target path) so replays
    // through the proxy produce the same cache key.
    const storedEndpoint = url.pathname + url.search

    if (!upstream.body) {
      const emptyBody: Uint8Array = new Uint8Array(0)
      await this.storeCacheEntry({
        cacheKey,
        requestBody: requestText,
        endpoint: storedEndpoint,
        method: request.method,
        status: upstream.status,
        headers: upstreamHeaders,
        body: emptyBody,
      })
      return new Response(emptyBody, {
        status: upstream.status,
        headers: upstreamHeaders,
      })
    }

    const [clientStream, cacheStream] = upstream.body.tee()
    void this.persistStreamToCache({
      cacheKey,
      requestBody: requestText,
      endpoint: storedEndpoint,
      method: request.method,
      status: upstream.status,
      headers: upstreamHeaders,
      stream: cacheStream,
    }).catch(() => {
      return
    })

    return new Response(clientStream, {
      status: upstream.status,
      headers: upstreamHeaders,
    })
  }

  private tryParseJson({ text }: { text: string }): unknown {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  private computeCacheKey({
    method,
    pathname,
    search,
    body,
    anthropicVersion,
    anthropicBeta,
  }: {
    method: string
    pathname: string
    search: string
    body: unknown
    anthropicVersion: string
    anthropicBeta: string
  }): string {
    const normalizedBody = this.normalizeJson({ value: body })
    const payload = {
      method,
      pathname,
      search,
      anthropicVersion,
      anthropicBeta,
      body: normalizedBody,
    }
    const serialized = JSON.stringify(payload)
    return crypto.createHash('sha256').update(serialized).digest('hex')
  }

  private normalizeJson({ value }: { value: unknown }): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => {
        return this.normalizeJson({ value: item })
      })
    }
    if (!value || typeof value !== 'object') {
      return value
    }
    const record = value as Record<string, unknown>
    const sortedKeys = Object.keys(record).sort((a, b) => {
      if (a < b) {
        return -1
      }
      if (a > b) {
        return 1
      }
      return 0
    })
    const normalized: Record<string, unknown> = {}
    for (const key of sortedKeys) {
      normalized[key] = this.normalizeJson({ value: record[key] })
    }
    return normalized
  }

  private async ensureDatabaseReady() {
    if (this.database) {
      return
    }
    fs.mkdirSync(path.dirname(this.cacheDbPath), { recursive: true })
    const database = createClient({
      url: `file:${this.cacheDbPath}`,
    })
    // WAL mode + relaxed sync drastically reduce fsync overhead for local
    // libsql file: databases (libsql inserts are ~60x slower than
    // better-sqlite3 in default journal mode, WAL narrows the gap).
    await database.execute('PRAGMA journal_mode = WAL')
    await database.execute('PRAGMA synchronous = NORMAL')
    await database.execute(`
      CREATE TABLE IF NOT EXISTS ${CACHE_TABLE} (
        cache_key TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        request_body TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_headers TEXT NOT NULL,
        response_body BLOB NOT NULL,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      )
    `)
    this.database = database
  }

  private async lookupCache({
    cacheKey,
  }: {
    cacheKey: string
  }): Promise<CacheLookupResult | null> {
    await this.ensureDatabaseReady()
    const database = this.database
    if (!database) {
      return null
    }
    const result = await database.execute({
      sql: `
        SELECT response_status, response_headers, response_body
        FROM ${CACHE_TABLE}
        WHERE cache_key = ?
      `,
      args: [cacheKey],
    })
    const firstRow = result.rows[0]
    if (!firstRow) {
      return null
    }
    const parsed = this.parseCacheRow({
      row: firstRow as Record<string, unknown>,
    })
    if (!parsed) {
      return null
    }
    return parsed
  }

  private parseCacheRow({ row }: { row: Record<string, unknown> }) {
    const status = this.parseStatus({ value: row['response_status'] })
    const headers = this.parseHeaders({ value: row['response_headers'] })
    const body = this.parseBody({ value: row['response_body'] })
    if (!status || !headers || !body) {
      return null
    }
    const parsed: ParsedCacheRow = {
      status,
      headers,
      body,
    }
    return parsed
  }

  private parseStatus({ value }: { value: unknown }): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
    return null
  }

  private parseHeaders({ value }: { value: unknown }) {
    if (typeof value !== 'string') {
      return null
    }
    try {
      const parsed = JSON.parse(value) as unknown
      if (!parsed || typeof parsed !== 'object') {
        return null
      }
      const record = parsed as Record<string, unknown>
      const headers: Record<string, string> = {}
      for (const [key, headerValue] of Object.entries(record)) {
        if (typeof headerValue !== 'string') {
          continue
        }
        headers[key] = headerValue
      }
      return headers
    } catch {
      return null
    }
  }

  private parseBody({ value }: { value: unknown }) {
    if (value instanceof Uint8Array) {
      return value
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value)
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
      return new Uint8Array(value)
    }
    if (typeof value === 'string') {
      return new TextEncoder().encode(value)
    }
    if (Array.isArray(value)) {
      const numbers = value.filter((item) => {
        return typeof item === 'number'
      })
      if (numbers.length !== value.length) {
        return null
      }
      return new Uint8Array(numbers)
    }
    return null
  }

  private async persistStreamToCache({
    cacheKey,
    requestBody,
    endpoint,
    method,
    status,
    headers,
    stream,
  }: {
    cacheKey: string
    requestBody: string
    endpoint: string
    method: string
    status: number
    headers: Record<string, string>
    stream: ReadableStream<Uint8Array>
  }) {
    const bodyBuffer = await new Response(stream).arrayBuffer()
    const body = new Uint8Array(bodyBuffer)
    await this.storeCacheEntry({
      cacheKey,
      requestBody,
      endpoint,
      method,
      status,
      headers,
      body,
    })
  }

  private async storeCacheEntry({
    cacheKey,
    requestBody,
    endpoint,
    method,
    status,
    headers,
    body,
  }: {
    cacheKey: string
    requestBody: string
    endpoint: string
    method: string
    status: number
    headers: Record<string, string>
    body: Uint8Array
  }) {
    await this.ensureDatabaseReady()
    const database = this.database
    if (!database) {
      return
    }
    const now = new Date().toISOString()
    await database.execute({
      sql: `
        INSERT INTO ${CACHE_TABLE} (
          cache_key,
          endpoint,
          method,
          request_body,
          response_status,
          response_headers,
          response_body,
          created_at,
          last_accessed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          endpoint = excluded.endpoint,
          method = excluded.method,
          request_body = excluded.request_body,
          response_status = excluded.response_status,
          response_headers = excluded.response_headers,
          response_body = excluded.response_body,
          last_accessed_at = excluded.last_accessed_at
      `,
      args: [
        cacheKey,
        endpoint,
        method,
        requestBody,
        status,
        JSON.stringify(headers),
        body,
        now,
        now,
      ],
    })
  }

  private async forwardRequest({
    request,
    targetUrl,
  }: {
    request: Request
    targetUrl: URL
  }) {
    const targetUrlString = targetUrl.toString()
    const proxyRequest = new Request(targetUrlString, request)
    const headers = new Headers(proxyRequest.headers)

    headers.delete('host')
    headers.delete('content-length')

    for (const [key, value] of Object.entries(this.additionalHeaders)) {
      headers.set(key, value)
    }

    const outgoingAuthorization =
      this.upstreamAuthorization || this.authorization
    if (outgoingAuthorization) {
      headers.set('authorization', outgoingAuthorization)
    }

    if (this.upstreamApiKey && this.upstreamApiKeyHeader) {
      headers.set(this.upstreamApiKeyHeader, this.upstreamApiKey)
    }

    const forwardedRequest = new Request(targetUrlString, {
      method: proxyRequest.method,
      headers,
      body: proxyRequest.body,
      duplex: 'half',
    })
    return fetch(forwardedRequest)
  }

  private serializeResponseHeaders({
    headers,
  }: {
    headers: Headers
  }): Record<string, string> {
    const serialized: Record<string, string> = {}
    for (const [name, value] of headers.entries()) {
      if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
        continue
      }
      serialized[name] = value
    }
    return serialized
  }

  /** Parse cached SSE body with eventsource-parser, then re-serialize and
   *  drip events with delays. This simulates slow streaming so e2e tests
   *  can exercise timing-dependent paths like step-finish interrupts. */
  private createDelayedSSEStream({
    body,
    delayMs,
  }: {
    body: Uint8Array
    delayMs: number
  }): ReadableStream<Uint8Array> {
    const text = new TextDecoder().decode(body)
    const events: string[] = []
    const parser = createParser({
      onEvent(event) {
        // Re-serialize each parsed event back to SSE wire format
        const parts: string[] = []
        if (event.event) {
          parts.push(`event: ${event.event}`)
        }
        if (event.id) {
          parts.push(`id: ${event.id}`)
        }
        parts.push(`data: ${event.data}`)
        events.push(parts.join('\n') + '\n\n')
      },
    })
    parser.feed(text)

    const encoder = new TextEncoder()
    let index = 0
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= events.length) {
          controller.close()
          return
        }
        if (index > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs)
          })
        }
        controller.enqueue(encoder.encode(events[index]!))
        index++
      },
    })
  }
}
