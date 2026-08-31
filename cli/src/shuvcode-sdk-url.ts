// shuvcode v2 mounts the HTTP API under `/api/*`. The published
// `@opencode-ai/sdk/v2` client still emits unprefixed OpenCode v1 paths
// (`/session`, `/event`, `/session/{id}/prompt_async`). Point every SDK
// `baseUrl` at the `/api` origin, then rewrite request paths/bodies and
// unwrap `{ data }` responses so the existing client keeps working.
// The TUI `--server` flag still wants the process origin without `/api`.

import {
  lookupShuvcodeForm,
  lookupShuvcodePermissionSession,
} from './shuvcode-adapter-state.js'
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

export type ShuvcodeSessionPermissionRule = {
  permission: string
  pattern: string
  action: 'allow' | 'deny' | 'ask' | string
}

export function splitShuvcodeSessionPermissionRules(permission: unknown): {
  allowTools: string[]
  translatable: ShuvcodeSessionPermissionRule[]
  untranslatable: ShuvcodeSessionPermissionRule[]
} {
  const rules = Array.isArray(permission) ? permission : []
  const allowTools: string[] = []
  const translatable: ShuvcodeSessionPermissionRule[] = []
  const untranslatable: ShuvcodeSessionPermissionRule[] = []
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.permission !== 'string') continue
    const action = typeof rule.action === 'string' ? rule.action : ''
    const pattern = typeof rule.pattern === 'string' ? rule.pattern : '*'
    const normalized: ShuvcodeSessionPermissionRule = {
      permission: rule.permission,
      pattern,
      action,
    }
    if (action === 'allow' && (pattern === '*' || pattern.length === 0)) {
      if (!allowTools.includes(rule.permission)) allowTools.push(rule.permission)
      translatable.push(normalized)
      continue
    }
    untranslatable.push(normalized)
  }
  return { allowTools, translatable, untranslatable }
}

export function rewriteShuvcodePolicy(permission: unknown): {
  policy?: { tools: { allow: string[] } }
  untranslatable: ShuvcodeSessionPermissionRule[]
} {
  const { allowTools, untranslatable } = splitShuvcodeSessionPermissionRules(permission)
  return {
    ...(allowTools.length > 0 ? { policy: { tools: { allow: allowTools } } } : {}),
    untranslatable,
  }
}

export function unsupportedSessionPermissionError(
  rules: ShuvcodeSessionPermissionRule[],
): Error {
  const details = rules
    .map((rule) => `${rule.permission}:${rule.pattern ?? '*'}:${rule.action}`)
    .join(', ')
  return new Error(
    `Cannot start this session: shuvcode cannot apply required permission rules (${details}). Refusing to run with weaker isolation.`,
  )
}

export function assertShuvcodeSessionPermissionsTranslatable(
  permission: unknown,
): Error | undefined {
  const { untranslatable } = splitShuvcodeSessionPermissionRules(permission)
  if (untranslatable.length === 0) return undefined
  return unsupportedSessionPermissionError(untranslatable)
}

function unsupportedPermissionResponse(rules: ShuvcodeSessionPermissionRule[]) {
  const error = unsupportedSessionPermissionError(rules)
  return new Response(
    JSON.stringify({
      error: {
        name: 'SessionPolicyUnsupportedError',
        message: error.message,
      },
    }),
    {
      status: 422,
      headers: { 'content-type': 'application/json' },
    },
  )
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
  const { policy } = rewriteShuvcodePolicy(record.permission ?? record.policy)
  if (policy) rewritten.policy = policy
  else if (isRecord(record.policy)) rewritten.policy = record.policy
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
    else if (record.noReply === true) rewritten.resume = false
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
  if (typeof record.resume === 'boolean') rewritten.resume = record.resume
  else if (record.noReply === true) rewritten.resume = false
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
    .replace(/\/session\/([^/]+)\/revert$/, '/session/$1/revert/stage')
    .replace(/\/session\/([^/]+)\/unrevert$/, '/session/$1/revert/clear')
    .replace(/\/session\/([^/]+)\/summarize$/, '/session/$1/compact')
  return next
}

function rewriteShuvcodeForkBody(body: unknown): Record<string, unknown> {
  const record = isRecord(body) ? body : {}
  const messageID =
    typeof record.messageID === 'string'
      ? record.messageID
      : typeof record.messageId === 'string'
        ? record.messageId
        : undefined
  const rewritten: Record<string, unknown> = {
    boundary: messageID
      ? { type: 'through', messageID }
      : isRecord(record.boundary)
        ? record.boundary
        : { type: 'through' },
  }
  const { policy } = rewriteShuvcodePolicy(record.permission ?? record.policy)
  if (policy) rewritten.policy = policy
  else if (isRecord(record.policy)) rewritten.policy = record.policy
  return rewritten
}

function rewriteShuvcodeCompactBody(body: unknown): Record<string, unknown> {
  const record = isRecord(body) ? body : {}
  const rewritten: Record<string, unknown> = {}
  if (typeof record.id === 'string') rewritten.id = record.id
  if (typeof record.delivery === 'string') rewritten.delivery = record.delivery
  return rewritten
}

function rewriteShuvcodeRevertStageBody(body: unknown): Record<string, unknown> {
  const record = isRecord(body) ? body : {}
  const rewritten: Record<string, unknown> = {}
  if (typeof record.messageID === 'string') rewritten.messageID = record.messageID
  if (typeof record.files === 'boolean') rewritten.files = record.files
  return rewritten
}

function rewritePermissionReplyUrl({
  url,
  body,
}: {
  url: URL
  body: unknown
}): URL | Response {
  const next = new URL(url)
  const match = next.pathname.match(/\/permission\/([^/]+)\/reply$/)
  if (!match?.[1] || next.pathname.includes('/session/')) return next
  const record = isRecord(body) ? body : {}
  const sessionID =
    typeof record.sessionID === 'string'
      ? record.sessionID
      : lookupShuvcodePermissionSession(match[1])
  if (!sessionID) {
    return new Response(
      JSON.stringify({
        error: {
          name: 'PermissionReplyUnscopedError',
          message: `Cannot reply to permission ${match[1]} without a session ID`,
        },
      }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )
  }
  next.pathname = `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(match[1])}/reply`
  return next
}

function mapFormReplyValue(
  field: { type: string; options: Array<{ label: string; value: string }> },
  selected: string[],
): string | string[] | number | boolean | Error {
  const toValue = (label: string) => {
    const match = field.options.find(
      (option) => option.label === label || option.value === label,
    )
    return match?.value ?? label
  }
  if (field.type === 'multiselect') return selected.map(toValue)
  if (field.type === 'boolean') {
    const first = selected[0]?.toLowerCase()
    return first === 'yes' || first === 'true'
  }
  const value = selected[0] ? toValue(selected[0]) : ''
  if (field.type === 'number' || field.type === 'integer') {
    const parsed = value.trim() === '' ? Number.NaN : Number(value)
    if (Number.isFinite(parsed) && (field.type !== 'integer' || Number.isInteger(parsed))) {
      return parsed
    }
    return new Error(`Invalid ${field.type} answer`)
  }
  return value
}

function rewriteQuestionReply({
  url,
  body,
}: {
  url: URL
  body: unknown
}): { url: URL; body: string } | Response {
  const match = url.pathname.match(/\/question\/([^/]+)\/reply$/)
  if (!match?.[1]) return { url, body: JSON.stringify(isRecord(body) ? body : {}) }
  const form = lookupShuvcodeForm(match[1])
  const record = isRecord(body) ? body : {}
  const sessionID =
    form?.sessionID ??
    (typeof record.sessionID === 'string' ? record.sessionID : undefined)
  if (!sessionID || !form) {
    return new Response(
      JSON.stringify({
        error: {
          name: 'QuestionReplyUnscopedError',
          message: `Cannot reply to question ${match[1]} without the originating form`,
        },
      }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )
  }
  const answers = Array.isArray(record.answers) ? record.answers : []
  const answer: Record<string, string | string[] | number | boolean> = {}
  for (const [index, field] of form.fields.entries()) {
    const selected = Array.isArray(answers[index])
      ? answers[index].filter((item): item is string => typeof item === 'string')
      : []
    const value = mapFormReplyValue(field, selected)
    if (value instanceof Error) {
      return new Response(
        JSON.stringify({
          name: 'QuestionReplyValidationError',
          message: `${value.message} for field ${field.key}`,
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      )
    }
    answer[field.key] = value
  }
  const next = new URL(url)
  next.pathname = `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(match[1])}/reply`
  return { url: next, body: JSON.stringify({ answer }) }
}

function parseJsonBody(raw: string): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

export async function rewriteShuvcodeSdkRequest(
  request: Request,
): Promise<Request | Response> {
  let url = rewriteShuvcodeRequestUrl(new URL(request.url))
  let pathname = url.pathname
  let method = request.method.toUpperCase()

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
  const record = isRecord(parsed) ? parsed : {}

  if (method === 'PATCH' && /\/session\/[^/]+$/.test(pathname)) {
    const sessionMatch = pathname.match(/\/session\/([^/]+)$/)
    const sessionID = sessionMatch?.[1]
    if (record.permission !== undefined) {
      const { untranslatable } = rewriteShuvcodePolicy(record.permission)
      return unsupportedPermissionResponse(
        untranslatable.length > 0
          ? untranslatable
          : [{ permission: 'session.update', pattern: '*', action: 'ask' }],
      )
    }
    if (sessionID && typeof record.title === 'string') {
      url.pathname = `/api/session/${encodeURIComponent(sessionID)}/rename`
      return new Request(url.href, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify({ title: record.title }),
      })
    }
  }

  if (method === 'POST' && /\/permission\/[^/]+\/reply$/.test(pathname)) {
    const rewrittenUrl = rewritePermissionReplyUrl({ url, body: parsed })
    if (rewrittenUrl instanceof Response) return rewrittenUrl
    url = rewrittenUrl
    pathname = url.pathname
  }

  if (method === 'POST' && /\/question\/[^/]+\/reply$/.test(pathname)) {
    const rewritten = rewriteQuestionReply({ url, body: parsed })
    if (rewritten instanceof Response) return rewritten
    return new Request(rewritten.url.href, {
      method: 'POST',
      headers: request.headers,
      body: rewritten.body,
    })
  }

  let body = raw
  if (
    method === 'POST' &&
    (pathname === '/session' || pathname === '/api/session')
  ) {
    const { untranslatable } = rewriteShuvcodePolicy(record.permission)
    if (untranslatable.length > 0) return unsupportedPermissionResponse(untranslatable)
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
  } else if (method === 'POST' && pathname.endsWith('/fork')) {
    const { untranslatable } = rewriteShuvcodePolicy(record.permission)
    if (untranslatable.length > 0) return unsupportedPermissionResponse(untranslatable)
    body = JSON.stringify(rewriteShuvcodeForkBody(parsed))
  } else if (method === 'POST' && pathname.endsWith('/compact')) {
    body = JSON.stringify(rewriteShuvcodeCompactBody(parsed))
  } else if (method === 'POST' && pathname.endsWith('/revert/stage')) {
    body = JSON.stringify(rewriteShuvcodeRevertStageBody(parsed))
  }

  return new Request(url.href, {
    method,
    headers: request.headers,
    body,
  })
}

export function unwrapShuvcodeJsonBody(body: unknown): unknown {
  if (!isRecord(body) || !('data' in body)) return body
  const extraKeys = Object.keys(body).filter(
    (key) => key !== 'data' && key !== 'cursor' && key !== 'location',
  )
  if (extraKeys.length > 0) return body
  return body.data
}

export function mapShuvcodeProviderList({
  providers,
  models,
  defaultModel,
}: {
  providers: unknown
  models?: unknown
  defaultModel?: unknown
}): {
  all: Array<Record<string, unknown>>
  connected: string[]
  default: Record<string, string>
} {
  const providerList = Array.isArray(providers) ? providers : []
  const modelList = Array.isArray(models) ? models : []
  const modelsByProvider = new Map<string, Record<string, Record<string, unknown>>>()
  for (const model of modelList) {
    if (!isRecord(model)) continue
    const providerID = typeof model.providerID === 'string' ? model.providerID : undefined
    const modelID = typeof model.modelID === 'string'
      ? model.modelID
      : typeof model.id === 'string'
        ? model.id
        : undefined
    if (!providerID || !modelID) continue
    const bucket = modelsByProvider.get(providerID) ?? {}
    bucket[modelID] = {
      id: modelID,
      name: typeof model.name === 'string' ? model.name : modelID,
      release_date: isRecord(model.time) && typeof model.time.released === 'number'
        ? new Date(model.time.released).toISOString().slice(0, 10)
        : undefined,
      limit: model.limit,
      capabilities: model.capabilities,
      status: model.status,
    }
    modelsByProvider.set(providerID, bucket)
  }

  const all = providerList.flatMap((provider) => {
    if (!isRecord(provider) || typeof provider.id !== 'string') return []
    const activation = typeof provider.activation === 'string' ? provider.activation : 'auto'
    return [
      {
        id: provider.id,
        name: typeof provider.name === 'string' ? provider.name : provider.id,
        activation,
        models: modelsByProvider.get(provider.id) ?? {},
      },
    ]
  })
  const connected = all
    .filter((provider) => provider.activation !== 'disabled')
    .map((provider) => provider.id)
  const defaultRecord: Record<string, string> = {}
  if (isRecord(defaultModel)) {
    const providerID =
      typeof defaultModel.providerID === 'string' ? defaultModel.providerID : undefined
    const modelID =
      typeof defaultModel.modelID === 'string'
        ? defaultModel.modelID
        : typeof defaultModel.id === 'string'
          ? defaultModel.id
          : undefined
    if (providerID && modelID) defaultRecord[providerID] = modelID
  }
  return { all, connected, default: defaultRecord }
}

export function mapShuvcodeSessionMessages(
  body: unknown,
  options?: { sessionID?: string },
): unknown {
  const messages = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.data)
      ? body.data
      : []
  const sessionID = options?.sessionID
  const chronological = [...messages].sort((left, right) => {
    return readSessionMessageCreated(left) - readSessionMessageCreated(right)
  })
  const models = chronological.map((message) => readSessionMessageModel(message))
  return chronological.map((message, index) =>
    mapShuvcodeSessionMessage(message, {
      sessionID,
      model: inferSessionMessageModel(models, index),
    }),
  )
}

function readSessionMessageCreated(message: unknown): number {
  if (!isRecord(message)) return 0
  const time = isRecord(message.info) && isRecord(message.info.time)
    ? message.info.time
    : isRecord(message.time)
      ? message.time
      : {}
  return typeof time.created === 'number' ? time.created : 0
}

function readSessionMessageModel(
  message: unknown,
): { providerID: string; modelID: string } | undefined {
  if (!isRecord(message)) return undefined
  if (isRecord(message.info) && message.info.role === 'assistant') {
    const providerID =
      typeof message.info.providerID === 'string' ? message.info.providerID : ''
    const modelID =
      typeof message.info.modelID === 'string' ? message.info.modelID : ''
    if (providerID || modelID) return { providerID, modelID }
  }
  if (message.type !== 'assistant') return undefined
  const model = isRecord(message.model) ? message.model : {}
  const modelID =
    typeof model.id === 'string'
      ? model.id
      : typeof model.modelID === 'string'
        ? model.modelID
        : ''
  const providerID = typeof model.providerID === 'string' ? model.providerID : ''
  if (!providerID && !modelID) return undefined
  return { providerID, modelID }
}

function inferSessionMessageModel(
  models: Array<{ providerID: string; modelID: string } | undefined>,
  index: number,
): { providerID: string; modelID: string } {
  for (let i = index + 1; i < models.length; i++) {
    const next = models[i]
    if (next) return next
  }
  for (let i = index - 1; i >= 0; i--) {
    const previous = models[i]
    if (previous) return previous
  }
  return { providerID: '', modelID: '' }
}

function mapShuvcodeToolState(
  part: Record<string, unknown>,
): Record<string, unknown> {
  const state = isRecord(part.state) ? part.state : {}
  const status = typeof state.status === 'string' ? state.status : 'pending'
  const input = isRecord(state.input) ? state.input : {}
  const stateTime = isRecord(state.time) ? state.time : {}
  const partTime = isRecord(part.time) ? part.time : {}
  const start =
    typeof stateTime.start === 'number'
      ? stateTime.start
      : typeof partTime.ran === 'number'
        ? partTime.ran
        : typeof partTime.created === 'number'
          ? partTime.created
          : 0
  const end =
    typeof stateTime.end === 'number'
      ? stateTime.end
      : typeof partTime.completed === 'number'
        ? partTime.completed
        : start
  const metadata = isRecord(state.metadata) ? state.metadata : {}
  const toolName =
    typeof part.tool === 'string'
      ? part.tool
      : typeof part.name === 'string'
        ? part.name
        : 'tool'
  if (status === 'completed') {
    const content = Array.isArray(state.content) ? state.content : []
    const output =
      typeof state.output === 'string'
        ? state.output
        : content
            .map((item) =>
              isRecord(item) && typeof item.text === 'string' ? item.text : '',
            )
            .filter((item) => item.length > 0)
            .join('\n')
    const titledContent = content.find(
      (item) => isRecord(item) && typeof item.title === 'string',
    )
    const title =
      typeof state.title === 'string'
        ? state.title
        : isRecord(titledContent) && typeof titledContent.title === 'string'
          ? titledContent.title
          : toolName
    return {
      status: 'completed',
      input,
      output,
      title,
      metadata,
      time: { start, end },
    }
  }
  if (status === 'error') {
    const error =
      typeof state.error === 'string'
        ? state.error
        : isRecord(state.error) && typeof state.error.message === 'string'
          ? state.error.message
          : 'Unknown error'
    return {
      status: 'error',
      input,
      error,
      metadata,
      time: { start, end },
    }
  }
  if (status === 'running') {
    return {
      status: 'running',
      input,
      metadata,
      time: { start },
    }
  }
  return {
    status: 'pending',
    input,
    raw: typeof state.raw === 'string' ? state.raw : '',
  }
}

function mapShuvcodeMessagePart(part: unknown): unknown {
  if (!isRecord(part) || part.type !== 'tool') return part
  return {
    ...part,
    state: mapShuvcodeToolState(part),
  }
}

function mapShuvcodeSessionMessage(
  message: unknown,
  options: {
    sessionID?: string
    model: { providerID: string; modelID: string }
  },
): Record<string, unknown> {
  if (!isRecord(message)) {
    return {
      info: {
        sessionID: options.sessionID,
        role: 'user',
        time: { created: 0 },
        model: options.model,
      },
      parts: [],
    }
  }
  if (isRecord(message.info)) {
    const info: Record<string, unknown> = {
      ...message.info,
      sessionID:
        typeof message.info.sessionID === 'string'
          ? message.info.sessionID
          : options.sessionID,
    }
    if (info.role === 'user' && !isRecord(info.model)) {
      info.model = options.model
    }
    const parts = Array.isArray(message.parts)
      ? message.parts.map((part) => mapShuvcodeMessagePart(part))
      : []
    return { info, parts }
  }
  const type = typeof message.type === 'string' ? message.type : undefined
  const id = typeof message.id === 'string' ? message.id : ''
  const created = isRecord(message.time) && typeof message.time.created === 'number'
    ? message.time.created
    : 0
  const completed = isRecord(message.time) && typeof message.time.completed === 'number'
    ? message.time.completed
    : undefined
  if (type === 'user') {
    return {
      info: {
        id,
        sessionID: options.sessionID,
        role: 'user',
        time: { created },
        model: options.model,
      },
      parts: typeof message.text === 'string'
        ? [{ type: 'text', text: message.text }]
        : [],
    }
  }
  if (type === 'assistant') {
    const model = isRecord(message.model) ? message.model : {}
    const content = Array.isArray(message.content) ? message.content : []
    return {
      info: {
        id,
        sessionID: options.sessionID,
        role: 'assistant',
        parentID: typeof message.parentID === 'string' ? message.parentID : undefined,
        agent: typeof message.agent === 'string' ? message.agent : undefined,
        modelID: typeof model.id === 'string' ? model.id : undefined,
        providerID: typeof model.providerID === 'string' ? model.providerID : undefined,
        time: completed === undefined ? { created } : { created, completed },
        finish: message.finish,
        tokens: message.tokens,
        cost: message.cost ?? 0,
      },
      parts: content.flatMap((part): Record<string, unknown>[] => {
        if (!isRecord(part)) return []
        if (part.type === 'text' && typeof part.text === 'string') {
          return [{ type: 'text', text: part.text }]
        }
        if (part.type === 'reasoning' && typeof part.text === 'string') {
          return [{ type: 'reasoning', text: part.text }]
        }
        if (part.type === 'tool' && typeof part.id === 'string') {
          const tool = typeof part.name === 'string' ? part.name : 'tool'
          return [
            {
              type: 'tool',
              callID: part.id,
              tool,
              state: mapShuvcodeToolState({ ...part, tool }),
            },
          ]
        }
        return []
      }),
    }
  }
  return {
    info: {
      id,
      sessionID: options.sessionID,
      role: type ?? 'user',
      time: { created },
      model: options.model,
    },
    parts: [],
  }
}

export function mapShuvcodeRevertResponse(body: unknown): unknown {
  const revert = isRecord(body) && isRecord(body.revert)
    ? body.revert
    : isRecord(body)
      ? body
      : {}
  const files = Array.isArray(revert.files) ? revert.files : []
  const diff = files
    .map((file) => (isRecord(file) && typeof file.patch === 'string' ? file.patch : ''))
    .filter(Boolean)
    .join('\n')
  return {
    revert: {
      ...revert,
      ...(diff ? { diff } : {}),
    },
  }
}

export function mapShuvcodeSessionInfo(body: unknown): unknown {
  if (!isRecord(body)) return body
  const location = isRecord(body.location) ? body.location : {}
  if (typeof body.directory === 'string' || typeof location.directory !== 'string') {
    return body
  }
  return {
    ...body,
    directory: location.directory,
  }
}

function isProviderListPath(pathname: string) {
  return pathname === '/provider' || pathname === '/api/provider'
}

function isSessionMessageListPath(pathname: string) {
  return /\/session\/[^/]+\/message$/.test(pathname)
}

function sessionIdFromMessageListPath(pathname: string): string | undefined {
  const match = pathname.match(/\/session\/([^/]+)\/message$/)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

function isSessionCollectionPath(pathname: string) {
  return pathname === '/session' || pathname === '/api/session'
}

function isRevertStagePath(pathname: string) {
  return pathname.endsWith('/revert/stage')
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
  requestHeaders?: Headers,
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
  } else if (isProviderListPath(pathname)) {
    const providers = Array.isArray(body)
      ? body
      : isRecord(parsed) && Array.isArray(parsed.data)
        ? parsed.data
        : []
    const catalog = await loadShuvcodeModelCatalog({
      origin: requestUrl ? new URL(requestUrl).origin : undefined,
      headers: requestHeaders,
    })
    body = mapShuvcodeProviderList({
      providers,
      models: catalog.models,
      defaultModel: catalog.defaultModel,
    })
  } else if (isSessionMessageListPath(pathname)) {
    body = mapShuvcodeSessionMessages(body, {
      sessionID: sessionIdFromMessageListPath(pathname),
    })
  } else if (isRevertStagePath(pathname)) {
    body = mapShuvcodeRevertResponse(body)
  } else if (
    (isSessionCollectionPath(pathname) && !Array.isArray(body)) ||
    /\/session\/[^/]+$/.test(pathname) ||
    pathname.endsWith('/fork')
  ) {
    body = mapShuvcodeSessionInfo(body)
  }

  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': 'application/json' },
  })
}

async function loadShuvcodeModelCatalog({
  origin,
  headers,
}: {
  origin?: string
  headers?: Headers
}): Promise<{ models: unknown; defaultModel: unknown }> {
  if (!origin) return { models: [], defaultModel: null }
  const authorization = headers?.get('authorization')
  const requestHeaders: Record<string, string> = {}
  if (authorization) requestHeaders.authorization = authorization
  const [modelsResponse, defaultResponse] = await Promise.all([
    fetch(`${origin}/api/model`, { headers: requestHeaders }).catch(() => null),
    fetch(`${origin}/api/model/default`, { headers: requestHeaders }).catch(() => null),
  ])
  const modelsJson = modelsResponse
    ? await modelsResponse.json().catch(() => null)
    : null
  const defaultJson = defaultResponse
    ? await defaultResponse.json().catch(() => null)
    : null
  return {
    models: unwrapShuvcodeJsonBody(modelsJson) ?? [],
    defaultModel: unwrapShuvcodeJsonBody(defaultJson) ?? null,
  }
}

export async function moveForkedShuvcodeSession({
  origin,
  headers,
  sessionID,
  directory,
}: {
  origin: string
  headers: Headers
  sessionID: string
  directory: string
}): Promise<Error | undefined> {
  const authorization = headers.get('authorization')
  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (authorization) requestHeaders.authorization = authorization
  const response = await fetch(
    `${origin}/api/session/${encodeURIComponent(sessionID)}/move`,
    {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ directory }),
    },
  ).catch((error) =>
    error instanceof Error ? error : new Error(String(error)),
  )
  if (response instanceof Error) {
    return new Error(
      `Failed to move forked session ${sessionID} to ${directory}: ${response.message}`,
      { cause: response },
    )
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return new Error(
      `Failed to move forked session ${sessionID} to ${directory}: ${response.status}${text ? ` ${text}` : ''}`,
    )
  }
  return undefined
}

export async function fetchShuvcodeSdk(
  input: Request | URL | string,
  init?: RequestInit,
): Promise<Response> {
  const request =
    input instanceof Request ? input : new Request(String(input), init)
  const rewritten = await rewriteShuvcodeSdkRequest(request)
  if (rewritten instanceof Response) return rewritten
  const response = await fetch(rewritten)
  const mapped = await rewriteShuvcodeSdkResponse(
    response,
    rewritten.url,
    request.headers,
  )
  if (
    rewritten.method.toUpperCase() === 'POST' &&
    rewritten.url.includes('/fork') &&
    mapped.ok
  ) {
    const directory =
      request.headers.get('x-opencode-directory') ??
      new URL(request.url).searchParams.get('directory')
    if (directory) {
      const parsed = await mapped
        .clone()
        .json()
        .catch(() => null)
      const sessionID =
        isRecord(parsed) && typeof parsed.id === 'string' ? parsed.id : undefined
      if (!sessionID) {
        return new Response(
          JSON.stringify({
            name: 'SessionMoveError',
            message:
              'Fork succeeded but session id was missing; refusing to bind a worktree session that was not moved',
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
      }
      const moveError = await moveForkedShuvcodeSession({
        origin: new URL(rewritten.url).origin,
        headers: request.headers,
        sessionID,
        directory,
      })
      if (moveError) {
        return new Response(
          JSON.stringify({
            name: 'SessionMoveError',
            message: moveError.message,
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
      }
    }
  }
  return mapped
}

export function createShuvcodeSdkFetch(): typeof fetch {
  return fetchShuvcodeSdk as typeof fetch
}
