// Translate shuvcode v2 SSE events into the @opencode-ai/sdk/v2 Event
// shapes the Discord runtime already understands.
//
// shuvcode emits `{ type, data }` (`session.text.ended`, `session.tool.called`).
// The bot's event sourcing reads `{ type, properties }` (`message.part.updated`,
// `session.status`, `session.idle`).

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

export function translateShuvcodeEvent(event: unknown): unknown[] {
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
    case 'session.execution.started':
      return sessionID ? [sessionStatus({ sessionID, type: 'busy' })] : []
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      return sessionID
        ? [sessionStatus({ sessionID, type: 'idle' }), sessionIdle(sessionID)]
        : []
    case 'session.step.started': {
      const messageID = asString(data.assistantMessageID)
      if (!sessionID || !messageID) return []
      return [
        sessionStatus({ sessionID, type: 'busy' }),
        partUpdated({
          id: `step-start-${messageID}`,
          sessionID,
          messageID,
          type: 'step-start',
        }),
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
    case 'session.tool.called': {
      const messageID = asString(data.assistantMessageID)
      const toolID = asString(data.id)
      const tool = asString(data.name) ?? asString(data.tool) ?? 'tool'
      if (!sessionID || !messageID || !toolID) return []
      return [
        partUpdated({
          id: toolPartId({ sessionID, toolID }),
          sessionID,
          messageID,
          type: 'tool',
          callID: toolID,
          tool,
          state: {
            status: 'running',
            input: isRecord(data.input) ? data.input : {},
            time: { start: created },
          },
        }),
      ]
    }
    case 'session.tool.success': {
      const messageID = asString(data.assistantMessageID)
      const toolID = asString(data.id)
      if (!sessionID || !messageID || !toolID) return []
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
          messageID,
          type: 'tool',
          callID: toolID,
          tool: asString(data.name) ?? asString(data.tool) ?? 'tool',
          state: {
            status: 'completed',
            input: {},
            output,
            title: asString(data.name) ?? 'tool',
            metadata: isRecord(data.metadata) ? data.metadata : {},
            time: { start: created, end: created },
          },
        }),
      ]
    }
    case 'session.tool.failed': {
      const messageID = asString(data.assistantMessageID)
      const toolID = asString(data.id)
      if (!sessionID || !messageID || !toolID) return []
      const error = isRecord(data.error)
        ? asString(data.error.message) ?? asString(data.error.type) ?? 'tool failed'
        : 'tool failed'
      return [
        partUpdated({
          id: toolPartId({ sessionID, toolID }),
          sessionID,
          messageID,
          type: 'tool',
          callID: toolID,
          tool: asString(data.name) ?? asString(data.tool) ?? 'tool',
          state: {
            status: 'error',
            input: {},
            error,
            time: { start: created, end: created },
          },
        }),
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

export function rewriteSseBlock(block: string): string {
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
  const events = translateShuvcodeEvent(parsed)
  if (events.length === 0) return block
  return events
    .map((event) => [...other, `data: ${JSON.stringify(event)}`].join('\n'))
    .join('\n\n')
}
