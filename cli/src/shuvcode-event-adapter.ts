// Translate shuvcode v2 SSE events into the @opencode-ai/sdk/v2 Event
// shapes the Discord runtime already understands.
//
// shuvcode emits `{ type, data }` (`session.text.ended`, `session.tool.called`).
// The bot's event sourcing reads `{ type, properties }` (`message.updated`,
// `message.part.updated`, `session.status`, `session.idle`).

import {
  rememberShuvcodeForm,
  rememberShuvcodePermissionRequest,
  type RememberedFormField,
} from './shuvcode-adapter-state.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function textPartId({
  sessionID,
  messageID,
  ordinal,
}: {
  sessionID: string
  messageID: string
  ordinal?: number
}) {
  return `text-${sessionID}-${messageID}-${ordinal ?? 0}`
}

function toolPartId({
  sessionID,
  toolID,
}: {
  sessionID: string
  toolID: string
}) {
  return `tool-${sessionID}-${toolID}`
}

function partUpdated(part: Record<string, unknown>) {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: part.sessionID,
      part,
    },
  }
}

function messageUpdated(info: Record<string, unknown>) {
  return {
    type: 'message.updated',
    properties: { info },
  }
}

function sessionStatus({
  sessionID,
  type,
}: {
  sessionID: string
  type: 'busy' | 'idle' | 'retry'
}) {
  return {
    type: 'session.status',
    properties: {
      sessionID,
      status: { type },
    },
  }
}

function sessionIdle(sessionID: string) {
  return {
    type: 'session.idle',
    properties: { sessionID },
  }
}

function sessionError({
  sessionID,
  error,
}: {
  sessionID: string
  error: unknown
}) {
  const record = isRecord(error) ? error : {}
  const message =
    asString(record.message) ??
    asString(record.type) ??
    (typeof error === 'string' ? error : 'Session failed')
  return {
    type: 'session.error',
    properties: {
      sessionID,
      error: {
        name: asString(record.type) ?? asString(record.name) ?? 'SessionError',
        data: {
          message,
          statusCode: asNumber(record.status),
        },
      },
    },
  }
}

function executionTerminalEvents({
  sessionID,
  error,
}: {
  sessionID: string
  error?: unknown
}) {
  return [
    ...(error === undefined ? [] : [sessionError({ sessionID, error })]),
    sessionStatus({ sessionID, type: 'idle' }),
    sessionIdle(sessionID),
  ]
}

function emptyTokens() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
}

function readTokens(value: unknown) {
  if (!isRecord(value)) return emptyTokens()
  const cache = isRecord(value.cache) ? value.cache : {}
  return {
    input: asNumber(value.input) ?? 0,
    output: asNumber(value.output) ?? 0,
    reasoning: asNumber(value.reasoning) ?? 0,
    cache: {
      read: asNumber(cache.read) ?? 0,
      write: asNumber(cache.write) ?? 0,
    },
  }
}

function mapFormField(field: unknown): {
  question: {
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple: boolean
  }
  remembered: RememberedFormField
} | undefined {
  if (!isRecord(field) || typeof field.key !== 'string') return undefined
  const title = asString(field.title) ?? field.key
  const description = asString(field.description)
  const type = asString(field.type) ?? 'string'
  let optionPairs: Array<{ label: string; description: string; value: string }> = []
  if (Array.isArray(field.options)) {
    optionPairs = field.options.flatMap((option) => {
      if (typeof option === 'string') {
        return [{ label: option, description: '', value: option }]
      }
      if (!isRecord(option)) return []
      const value = asString(option.value) ?? asString(option.label)
      const label = asString(option.label) ?? value
      if (!label) return []
      return [
        {
          label,
          description: asString(option.description) ?? '',
          value: value ?? label,
        },
      ]
    })
  } else if (type === 'boolean') {
    optionPairs = [
      { label: 'Yes', description: '', value: 'Yes' },
      { label: 'No', description: '', value: 'No' },
    ]
  }
  if (optionPairs.length < 2) {
    optionPairs = [
      ...optionPairs,
      { label: 'Yes', description: '', value: 'Yes' },
      { label: 'No', description: '', value: 'No' },
    ]
  }
  return {
    question: {
      question: description || title,
      header: title.slice(0, 12),
      options: optionPairs.map((option) => ({
        label: option.label,
        description: option.description,
      })),
      multiple: type === 'multiselect',
    },
    remembered: {
      key: field.key,
      type,
      options: optionPairs.map(({ label, value }) => ({ label, value })),
    },
  }
}

function readModel(value: unknown): { id: string; providerID: string } | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value.id) ?? asString(value.modelID)
  const providerID = asString(value.providerID)
  if (!id || !providerID) return undefined
  return { id, providerID }
}

export type ShuvcodeToolCallState = {
  name: string
  input: Record<string, unknown>
  messageID?: string
}

export type ShuvcodeEventTranslateState = {
  lastUserMessageIdBySession: Map<string, string>
  lastAssistantBySession: Map<
    string,
    {
      id: string
      agent?: string
      modelID?: string
      providerID?: string
    }
  >
  toolsByCallId: Map<string, ShuvcodeToolCallState>
}

export function createShuvcodeEventTranslateState(): ShuvcodeEventTranslateState {
  return {
    lastUserMessageIdBySession: new Map(),
    lastAssistantBySession: new Map(),
    toolsByCallId: new Map(),
  }
}

function rememberToolCall({
  state,
  toolID,
  name,
  input,
  messageID,
}: {
  state: ShuvcodeEventTranslateState
  toolID: string
  name?: string
  input?: Record<string, unknown>
  messageID?: string
}): ShuvcodeToolCallState {
  const existing = state.toolsByCallId.get(toolID)
  const remembered: ShuvcodeToolCallState = {
    name: name || existing?.name || 'tool',
    input: input && Object.keys(input).length > 0 ? input : existing?.input ?? {},
    messageID: messageID || existing?.messageID,
  }
  state.toolsByCallId.set(toolID, remembered)
  return remembered
}

function readToolInput(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = erroreTryJson(value)
  return isRecord(parsed) ? parsed : undefined
}

function erroreTryJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

export type ShuvcodeEventTranslator = (event: unknown) => unknown[]

export function createShuvcodeEventTranslator(): ShuvcodeEventTranslator {
  const state = createShuvcodeEventTranslateState()
  return (event) => translateShuvcodeEvent(event, state)
}

function userMessageInfo({
  sessionID,
  messageID,
  created,
  agent,
}: {
  sessionID: string
  messageID: string
  created: number
  agent?: string
}) {
  return {
    id: messageID,
    sessionID,
    role: 'user',
    time: { created },
    ...(agent ? { agent } : {}),
  }
}

function assistantMessageInfo({
  sessionID,
  messageID,
  created,
  completed,
  parentID,
  agent,
  modelID,
  providerID,
  tokens,
  finish,
}: {
  sessionID: string
  messageID: string
  created: number
  completed?: number
  parentID?: string
  agent?: string
  modelID?: string
  providerID?: string
  tokens?: ReturnType<typeof readTokens>
  finish?: string
}) {
  return {
    id: messageID,
    sessionID,
    role: 'assistant',
    parentID,
    modelID,
    providerID,
    mode: agent,
    agent,
    time: completed === undefined ? { created } : { created, completed },
    cost: 0,
    tokens: tokens ?? emptyTokens(),
    ...(finish ? { finish } : {}),
  }
}

function rememberUserMessage({
  state,
  sessionID,
  messageID,
}: {
  state: ShuvcodeEventTranslateState
  sessionID: string
  messageID: string
}) {
  state.lastUserMessageIdBySession.set(sessionID, messageID)
}

function ensureUserMessage({
  state,
  sessionID,
  created,
}: {
  state: ShuvcodeEventTranslateState
  sessionID: string
  created: number
}): { id: string; events: unknown[] } {
  const existing = state.lastUserMessageIdBySession.get(sessionID)
  if (existing) return { id: existing, events: [] }
  const id = `user-${sessionID}-${created}`
  rememberUserMessage({ state, sessionID, messageID: id })
  return {
    id,
    events: [messageUpdated(userMessageInfo({ sessionID, messageID: id, created }))],
  }
}

export function translateShuvcodeEvent(
  event: unknown,
  state: ShuvcodeEventTranslateState = createShuvcodeEventTranslateState(),
): unknown[] {
  if (!isRecord(event) || typeof event.type !== 'string') return []
  if ('properties' in event && event.properties !== undefined) return [event]

  const data = isRecord(event.data) ? event.data : {}
  const sessionID = asString(data.sessionID)
  const created = asNumber(event.created) ?? Date.now()

  switch (event.type) {
    case 'session.status': {
      if (!sessionID) return []
      const status = isRecord(data.status) ? data.status : { type: 'idle' }
      return [
        {
          type: 'session.status',
          properties: { sessionID, status },
        },
      ]
    }
    case 'session.idle':
      return sessionID ? [sessionIdle(sessionID)] : []
    case 'session.created': {
      const id = sessionID || asString(data.id)
      if (!id) return []
      const location = isRecord(data.location) ? data.location : {}
      return [
        {
          type: 'session.created',
          properties: {
            info: {
              id,
              projectID: asString(data.projectID),
              directory: asString(location.directory),
              title: asString(data.title),
              time: { created, updated: created },
            },
          },
        },
      ]
    }
    case 'session.inbox.enqueued':
    case 'session.inbox.delivered': {
      if (!sessionID) return []
      const inboxID = asString(data.inboxID)
      const item = isRecord(data.item) ? data.item : {}
      if (!inboxID || (item.type && item.type !== 'user')) return []
      rememberUserMessage({ state, sessionID, messageID: inboxID })
      const payload = isRecord(item.payload) ? item.payload : {}
      const agents = Array.isArray(payload.agents) ? payload.agents : []
      const firstAgent = isRecord(agents[0]) ? asString(agents[0].name) : undefined
      return [
        messageUpdated(
          userMessageInfo({
            sessionID,
            messageID: inboxID,
            created,
            agent: firstAgent,
          }),
        ),
      ]
    }
    case 'session.agent.selected': {
      if (!sessionID) return []
      const current = state.lastAssistantBySession.get(sessionID)
      state.lastAssistantBySession.set(sessionID, {
        id: current?.id ?? '',
        agent: asString(data.agent),
        modelID: current?.modelID,
        providerID: current?.providerID,
      })
      return []
    }
    case 'session.model.selected': {
      if (!sessionID) return []
      const model = readModel(data.model)
      const current = state.lastAssistantBySession.get(sessionID)
      state.lastAssistantBySession.set(sessionID, {
        id: current?.id ?? '',
        agent: current?.agent,
        modelID: model?.id,
        providerID: model?.providerID,
      })
      return []
    }
    case 'session.execution.started':
      return sessionID ? [sessionStatus({ sessionID, type: 'busy' })] : []
    case 'session.execution.succeeded':
    case 'session.execution.interrupted':
      return sessionID
        ? [sessionStatus({ sessionID, type: 'idle' }), sessionIdle(sessionID)]
        : []
    case 'session.execution.failed':
      return sessionID
        ? executionTerminalEvents({ sessionID, error: data.error })
        : []
    case 'session.step.failed': {
      const messageID = asString(data.assistantMessageID)
      if (!sessionID) return []
      return [
        ...(messageID
          ? [
              messageUpdated(
                assistantMessageInfo({
                  sessionID,
                  messageID,
                  created,
                  completed: created,
                  parentID: state.lastUserMessageIdBySession.get(sessionID),
                  agent: state.lastAssistantBySession.get(sessionID)?.agent,
                  modelID: state.lastAssistantBySession.get(sessionID)?.modelID,
                  providerID: state.lastAssistantBySession.get(sessionID)?.providerID,
                  finish: asString(data.finish) ?? 'error',
                }),
              ),
            ]
          : []),
      ]
    }
    case 'session.step.started': {
      const messageID = asString(data.assistantMessageID)
      if (!sessionID || !messageID) return []
      const model = readModel(data.model)
      const agent = asString(data.agent)
      const user = ensureUserMessage({ state, sessionID, created })
      state.lastAssistantBySession.set(sessionID, {
        id: messageID,
        agent,
        modelID: model?.id,
        providerID: model?.providerID,
      })
      return [
        ...user.events,
        messageUpdated(
          assistantMessageInfo({
            sessionID,
            messageID,
            created,
            parentID: user.id,
            agent,
            modelID: model?.id,
            providerID: model?.providerID,
          }),
        ),
        sessionStatus({ sessionID, type: 'busy' }),
        partUpdated({
          id: `step-start-${messageID}`,
          sessionID,
          messageID,
          type: 'step-start',
        }),
      ]
    }
    case 'session.step.ended': {
      const messageID = asString(data.assistantMessageID)
      if (!sessionID || !messageID) return []
      const remembered = state.lastAssistantBySession.get(sessionID)
      const parentID = state.lastUserMessageIdBySession.get(sessionID)
      const tokens = readTokens(data.tokens)
      const finish = asString(data.finish)
      return [
        messageUpdated(
          assistantMessageInfo({
            sessionID,
            messageID,
            created,
            completed: created,
            parentID,
            agent: remembered?.agent ?? asString(data.agent),
            modelID: remembered?.modelID,
            providerID: remembered?.providerID,
            tokens,
            finish,
          }),
        ),
      ]
    }
    case 'session.text.ended': {
      const messageID = asString(data.assistantMessageID)
      const text = asString(data.text) ?? ''
      if (!sessionID || !messageID) return []
      return [
        partUpdated({
          id: textPartId({
            sessionID,
            messageID,
            ordinal: asNumber(data.ordinal),
          }),
          sessionID,
          messageID,
          type: 'text',
          text,
          time: { start: created, end: created },
        }),
      ]
    }
    case 'session.text.delta': {
      const messageID = asString(data.assistantMessageID)
      const delta = asString(data.delta) ?? ''
      if (!sessionID || !messageID) return []
      return [
        partUpdated({
          id: textPartId({
            sessionID,
            messageID,
            ordinal: asNumber(data.ordinal),
          }),
          sessionID,
          messageID,
          type: 'text',
          text: delta,
        }),
      ]
    }
    case 'session.tool.input.started': {
      const toolID = asString(data.id)
      const name = asString(data.name)
      const messageID = asString(data.assistantMessageID)
      if (!sessionID || !toolID) return []
      rememberToolCall({
        state,
        toolID,
        name,
        messageID,
      })
      return []
    }
    case 'session.tool.input.ended': {
      const toolID = asString(data.id)
      if (!sessionID || !toolID) return []
      rememberToolCall({
        state,
        toolID,
        input: readToolInput(data.text) ?? readToolInput(data.input),
        messageID: asString(data.assistantMessageID),
      })
      return []
    }
    case 'session.tool.called': {
      const messageID = asString(data.assistantMessageID)
      const toolID = asString(data.id)
      if (!sessionID || !messageID || !toolID) return []
      const remembered = rememberToolCall({
        state,
        toolID,
        name: asString(data.name) ?? asString(data.tool),
        input: readToolInput(data.input),
        messageID,
      })
      return [
        partUpdated({
          id: toolPartId({ sessionID, toolID }),
          sessionID,
          messageID,
          type: 'tool',
          callID: toolID,
          tool: remembered.name,
          state: {
            status: 'running',
            input: remembered.input,
            time: { start: created },
          },
        }),
      ]
    }
    case 'session.tool.success': {
      const messageID = asString(data.assistantMessageID)
      const toolID = asString(data.id)
      if (!sessionID || !toolID) return []
      const remembered = rememberToolCall({
        state,
        toolID,
        name: asString(data.name) ?? asString(data.tool),
        input: readToolInput(data.input),
        messageID,
      })
      const resolvedMessageID = messageID || remembered.messageID
      if (!resolvedMessageID) return []
      const content = Array.isArray(data.content) ? data.content : []
      const output = content
        .map((item) =>
          isRecord(item) && item.type === 'text' ? asString(item.text) : undefined,
        )
        .filter((item): item is string => Boolean(item))
        .join('\n')
      return [
        partUpdated({
          id: toolPartId({ sessionID, toolID }),
          sessionID,
          messageID: resolvedMessageID,
          type: 'tool',
          callID: toolID,
          tool: remembered.name,
          state: {
            status: 'completed',
            input: remembered.input,
            output,
            title: remembered.name,
            metadata: isRecord(data.metadata) ? data.metadata : {},
            time: { start: created, end: created },
          },
        }),
      ]
    }
    case 'session.tool.failed': {
      const messageID = asString(data.assistantMessageID)
      const toolID = asString(data.id)
      if (!sessionID || !toolID) return []
      const remembered = rememberToolCall({
        state,
        toolID,
        name: asString(data.name) ?? asString(data.tool),
        input: readToolInput(data.input),
        messageID,
      })
      const resolvedMessageID = messageID || remembered.messageID
      if (!resolvedMessageID) return []
      const error = isRecord(data.error)
        ? asString(data.error.message) ?? asString(data.error.type) ?? 'tool failed'
        : 'tool failed'
      return [
        partUpdated({
          id: toolPartId({ sessionID, toolID }),
          sessionID,
          messageID: resolvedMessageID,
          type: 'tool',
          callID: toolID,
          tool: remembered.name,
          state: {
            status: 'error',
            input: remembered.input,
            error,
            time: { start: created, end: created },
          },
        }),
      ]
    }
    case 'permission.asked': {
      const requestID = asString(data.id)
      const permissionSessionID = sessionID || asString(data.sessionID)
      if (!requestID || !permissionSessionID) return []
      rememberShuvcodePermissionRequest({
        requestID,
        sessionID: permissionSessionID,
      })
      const resources = Array.isArray(data.resources)
        ? data.resources.filter((item): item is string => typeof item === 'string')
        : []
      const save = Array.isArray(data.save)
        ? data.save.filter((item): item is string => typeof item === 'string')
        : []
      return [
        {
          type: 'permission.asked',
          properties: {
            id: requestID,
            sessionID: permissionSessionID,
            permission: asString(data.action) ?? asString(data.permission) ?? 'tool',
            patterns: resources.length > 0 ? resources : ['*'],
            always: save,
            metadata: isRecord(data.metadata) ? data.metadata : {},
          },
        },
      ]
    }
    case 'permission.replied': {
      const requestID = asString(data.requestID) ?? asString(data.id)
      const permissionSessionID = sessionID || asString(data.sessionID)
      if (!requestID || !permissionSessionID) return []
      return [
        {
          type: 'permission.replied',
          properties: {
            requestID,
            sessionID: permissionSessionID,
            reply: asString(data.reply) ?? 'reject',
          },
        },
      ]
    }
    case 'form.created': {
      const form = isRecord(data.form) ? data.form : data
      const formID = asString(form.id)
      const formSessionID = asString(form.sessionID) || sessionID
      const fields = Array.isArray(form.fields) ? form.fields : []
      if (!formID || !formSessionID) return []
      const mapped = fields.flatMap((field) => {
        const result = mapFormField(field)
        return result ? [result] : []
      })
      rememberShuvcodeForm({
        formID,
        sessionID: formSessionID,
        fields: mapped.map((field) => field.remembered),
      })
      return [
        {
          type: 'question.asked',
          properties: {
            id: formID,
            sessionID: formSessionID,
            questions: mapped.map((field) => field.question),
          },
        },
      ]
    }
    case 'form.replied': {
      const formID = asString(data.id)
      const formSessionID = sessionID || asString(data.sessionID)
      if (!formID || !formSessionID) return []
      return [
        {
          type: 'question.replied',
          properties: { sessionID: formSessionID, requestID: formID },
        },
      ]
    }
    case 'form.cancelled': {
      const formID = asString(data.id)
      const formSessionID = sessionID || asString(data.sessionID)
      if (!formID || !formSessionID) return []
      return [
        {
          type: 'question.rejected',
          properties: { sessionID: formSessionID, requestID: formID },
        },
      ]
    }
    default:
      if (sessionID && event.type.startsWith('session.')) {
        return [
          {
            type: event.type,
            properties: data,
          },
        ]
      }
      return []
  }
}

export function rewriteSseBlock(
  block: string,
  translate: ShuvcodeEventTranslator = translateShuvcodeEvent,
): string {
  const lines = block.split('\n')
  const dataLines: string[] = []
  const other: string[] = []
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.replace(/^data:\s*/, ''))
      continue
    }
    other.push(line)
  }
  if (dataLines.length === 0) return block
  let parsed: unknown
  try {
    parsed = JSON.parse(dataLines.join('\n'))
  } catch {
    return block
  }
  const events = translate(parsed)
  if (events.length === 0) return block
  return events
    .map((event) => [...other, `data: ${JSON.stringify(event)}`].join('\n'))
    .join('\n\n')
}
