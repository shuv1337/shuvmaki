// shuvcode v2 mounts the HTTP API under `/api/*`. The published
// `@opencode-ai/sdk/v2` client still emits unprefixed OpenCode v1 paths
// (`/session`, `/event`, `/session/{id}/prompt_async`). Point every SDK
// `baseUrl` at the `/api` origin, then rewrite request paths/bodies and
// unwrap `{ data }` responses so the existing client keeps working.
// The TUI `--server` flag still wants the process origin without `/api`.

import {
  createShuvcodeEventTranslator,
  rewriteSseBlock,
} from './shuvcode-event-adapter.js'

export function toShuvcodeSdkBaseUrl(originOrApiUrl: string): string {
  const trimmed = originOrApiUrl.replace(/\/$/, '')
  if (trimmed.endsWith('/api')) return trimmed
  return `${trimmed}/api`
}

export function buildShuvcodeOriginUrl({ port }: { port: number | string }) {
  return `http://127.0.0.1:${port}`
}

export function buildShuvcodeSdkBaseUrl({ port }: { port: number | string }) {
  return toShuvcodeSdkBaseUrl(buildShuvcodeOriginUrl({ port }))
}

export function isJsonContentType(contentType?: string | null) {
  return (contentType || '').toLowerCase().includes('application/json')
}

export function isReusableShuvcodeHealthResponse({
  status,
  contentType,
}: {
  status: number
  contentType?: string | null
}) {
  if (status < 200 || status >= 300) return false
  return isJsonContentType(contentType)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function rewriteShuvcodeSessionCreateBody({
  body,
  directory,
}: {
  body: unknown
  directory?: string
}): Record<string, unknown> {
  const record = isRecord(body) ? body : {}
  const rewritten: Record<string, unknown> = {}
  if (typeof record.id === 'string') rewritten.id = record.id
  if (typeof record.title === 'string') rewritten.title = record.title
  if (typeof record.agent === 'string') rewritten.agent = record.agent
  if (record.model && typeof record.model === 'object') rewritten.model = record.model
  const location = record.location
  const locationDirectory =
    isRecord(location) && typeof location.directory === 'string'
      ? location.directory
      : typeof record.directory === 'string'
        ? record.directory
        : directory
  if (locationDirectory) {
    rewritten.location = { directory: locationDirectory }
  }
  return rewritten
}

function promptMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const metadata = isRecord(record.metadata) ? { ...record.metadata } : {}
  if (typeof record.system === 'string') metadata.system = record.system
  if (record.model && typeof record.model === 'object') metadata.model = record.model
  if (typeof record.variant === 'string') metadata.variant = record.variant
  if (typeof record.noReply === 'boolean') metadata.noReply = record.noReply
  return metadata
}

export function rewriteShuvcodePromptBody(body: unknown): Record<string, unknown> {
  const record = isRecord(body) ? body : {}
  const metadata = promptMetadata(record)
  if (typeof record.text === 'string') {
    const rewritten: Record<string, unknown> = { text: record.text }
    if (Array.isArray(record.files)) rewritten.files = record.files
    if (Array.isArray(record.agents)) rewritten.agents = record.agents
    if (Array.isArray(record.skills)) rewritten.skills = record.skills
    if (Object.keys(metadata).length > 0) rewritten.metadata = metadata
    if (typeof record.delivery === 'string') rewritten.delivery = record.delivery
    if (typeof record.resume === 'boolean') rewritten.resume = record.resume
    if (typeof record.id === 'string') rewritten.id = record.id
    return rewritten
  }

  const parts = Array.isArray(record.parts) ? record.parts : []
  const texts: string[] = []
  const files: Array<{ uri: string; name?: string }> = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text)
      continue
    }
    if (part.type === 'file') {
      const uri =
        typeof part.uri === 'string'
          ? part.uri
          : typeof part.url === 'string'
            ? part.url
            : undefined
      if (!uri) continue
      files.push({
        uri,
        ...(typeof part.filename === 'string'
          ? { name: part.filename }
          : typeof part.name === 'string'
            ? { name: part.name }
            : {}),
      })
    }
  }

  const rewritten: Record<string, unknown> = { text: texts.join('\n') }
  if (files.length > 0) rewritten.files = files
  if (parts.length === 0) rewritten.resume = true
  if (typeof record.messageID === 'string') rewritten.id = record.messageID
  if (typeof record.id === 'string') rewritten.id = record.id
  if (typeof record.agent === 'string') {
    rewritten.agents = [{ name: record.agent }]
  }
  if (Object.keys(metadata).length > 0) rewritten.metadata = metadata
  return rewritten
}

export function readShuvcodePromptModel(body: unknown): {
  id: string
  providerID: string
  variant?: string
} | undefined {
  const record = isRecord(body) ? body : {}
  const model = isRecord(record.model) ? record.model : {}
  const id = typeof model.id === 'string'
    ? model.id
    : typeof model.modelID === 'string'
      ? model.modelID
      : undefined
  const providerID = typeof model.providerID === 'string' ? model.providerID : undefined
  if (!id || !providerID) return undefined
  const variant =
    typeof record.variant === 'string'
      ? record.variant
      : typeof model.variant === 'string'
        ? model.variant
        : undefined
  return variant ? { id, providerID, variant } : { id, providerID }
}

export async function applyShuvcodePromptSideEffects({
  origin,
  sessionID,
  headers,
  body,
}: {
  origin: string
  sessionID: string
  headers: Headers
  body: unknown
}): Promise<void> {
  const record = isRecord(body) ? body : {}
  const authorization = headers.get('authorization')
  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (authorization) requestHeaders.authorization = authorization

  const model = readShuvcodePromptModel(body)
  if (model) {
    await fetch(`${origin}/api/session/${encodeURIComponent(sessionID)}/model`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ model }),
    }).catch(() => null)
  }

  if (typeof record.agent === 'string') {
    await fetch(`${origin}/api/session/${encodeURIComponent(sessionID)}/agent`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ agent: record.agent }),
    }).catch(() => null)
  }

  if (typeof record.system === 'string' && record.system.length > 0) {
    await fetch(
      `${origin}/api/session/${encodeURIComponent(sessionID)}/instructions/entries/kimaki-system`,
      {
        method: 'PUT',
        headers: requestHeaders,
        body: JSON.stringify({ value: record.system }),
      },
    ).catch(() => null)
  }
}

export function rewriteShuvcodeRequestUrl(url: URL): URL {
  const next = new URL(url)
  next.pathname = next.pathname
    .replace(/\/prompt_async$/, '/prompt')
    .replace(/\/abort$/, '/interrupt')
    .replace(/\/session\/status$/, '/session/active')
  return next
}

function parseJsonBody(raw: string): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

export async function rewriteShuvcodeSdkRequest(request: Request): Promise<Request> {
  const url = rewriteShuvcodeRequestUrl(new URL(request.url))
  const pathname = url.pathname
  const method = request.method.toUpperCase()

  if (method === 'GET' || method === 'HEAD') {
    if (url.href === request.url) return request
    return new Request(url.href, {
      method: request.method,
      headers: request.headers,
    })
  }

  const raw = await request.clone().text()
  const parsed = parseJsonBody(raw)
  const headerDirectory = request.headers.get('x-opencode-directory')
  const directory = headerDirectory ? decodeURIComponent(headerDirectory) : undefined

  let body = raw
  if (
    method === 'POST' &&
    (pathname === '/session' || pathname === '/api/session')
  ) {
    body = JSON.stringify(
      rewriteShuvcodeSessionCreateBody({ body: parsed, directory }),
    )
  } else if (method === 'POST' && pathname.endsWith('/prompt')) {
    const sessionMatch = pathname.match(/\/session\/([^/]+)\/prompt$/)
    const sessionID = sessionMatch?.[1]
    if (sessionID) {
      await applyShuvcodePromptSideEffects({
        origin: url.origin,
        sessionID,
        headers: request.headers,
        body: parsed,
      })
    }
    body = JSON.stringify(rewriteShuvcodePromptBody(parsed))
  }

  return new Request(url.href, {
    method: request.method,
    headers: request.headers,
    body,
  })
}

export function unwrapShuvcodeJsonBody(body: unknown): unknown {
  if (!isRecord(body) || !('data' in body)) return body
  const extraKeys = Object.keys(body).filter((key) => key !== 'data' && key !== 'cursor')
  if (extraKeys.length > 0) return body
  return body.data
}

export function mapShuvcodeActiveSessions(body: unknown): unknown {
  if (!isRecord(body)) return body
  const mapped: Record<string, unknown> = {}
  for (const [sessionID, value] of Object.entries(body)) {
    if (isRecord(value) && value.type === 'running') {
      mapped[sessionID] = { type: 'busy' }
      continue
    }
    mapped[sessionID] = value
  }
  return mapped
}

function createSseRewriteStream() {
  let buffer = ''
  const translate = createShuvcodeEventTranslator()
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        controller.enqueue(`${rewriteSseBlock(part, translate)}\n\n`)
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(`${rewriteSseBlock(buffer, translate)}\n\n`)
      }
    },
  })
}

export function rewriteShuvcodeSseResponse(response: Response): Response {
  if (!response.body) return response
  const transformed = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(createSseRewriteStream())
    .pipeThrough(new TextEncoderStream())
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export async function rewriteShuvcodeSdkResponse(
  response: Response,
  requestUrl?: string,
): Promise<Response> {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.toLowerCase().includes('text/event-stream')) {
    return rewriteShuvcodeSseResponse(response)
  }
  if (!isJsonContentType(contentType) || response.status === 204) {
    return response
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return response
  }

  const pathname = (() => {
    const raw = requestUrl || response.url
    if (!raw) return ''
    try {
      return new URL(raw).pathname
    } catch {
      return ''
    }
  })()

  let body = unwrapShuvcodeJsonBody(parsed)
  if (pathname.endsWith('/session/active')) {
    body = mapShuvcodeActiveSessions(body)
  }

  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': 'application/json' },
  })
}

export async function fetchShuvcodeSdk(
  input: Request | URL | string,
  init?: RequestInit,
): Promise<Response> {
  const request =
    input instanceof Request ? input : new Request(String(input), init)
  const rewritten = await rewriteShuvcodeSdkRequest(request)
  const response = await fetch(rewritten)
  return rewriteShuvcodeSdkResponse(response, rewritten.url)
}

export function createShuvcodeSdkFetch(): typeof fetch {
  return fetchShuvcodeSdk as typeof fetch
}
