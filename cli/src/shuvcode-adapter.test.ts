import { afterEach, describe, expect, test } from 'vitest'
import {
  rememberShuvcodeForm,
  rememberShuvcodePermissionRequest,
  resetShuvcodeAdapterState,
} from './shuvcode-adapter-state.js'
import {
  createShuvcodeEventTranslateState,
  translateShuvcodeEvent,
} from './shuvcode-event-adapter.js'
import {
  mapShuvcodeProviderList,
  mapShuvcodeRevertResponse,
  mapShuvcodeSessionMessages,
  rewriteShuvcodePolicy,
  rewriteShuvcodePromptBody,
  rewriteShuvcodeSdkRequest,
  rewriteShuvcodeSessionCreateBody,
  splitShuvcodeSessionPermissionRules,
} from './shuvcode-sdk-url.js'

afterEach(() => {
  resetShuvcodeAdapterState()
})

describe('shuvcode session policy', () => {
  test('translates allow-tool rules and rejects deny/ask', () => {
    expect(
      splitShuvcodeSessionPermissionRules([
        { permission: 'bash', action: 'allow', pattern: '*' },
        { permission: 'external_directory', action: 'deny', pattern: '/repo' },
      ]),
    ).toEqual({
      allowTools: ['bash'],
      translatable: [{ permission: 'bash', pattern: '*', action: 'allow' }],
      untranslatable: [
        { permission: 'external_directory', pattern: '/repo', action: 'deny' },
      ],
    })
    expect(
      rewriteShuvcodePolicy([{ permission: 'edit', action: 'allow', pattern: '*' }]),
    ).toEqual({
      policy: { tools: { allow: ['edit'] } },
      untranslatable: [],
    })
    expect(
      rewriteShuvcodeSessionCreateBody({
        body: {
          title: 'isolated',
          permission: [{ permission: 'bash', action: 'allow', pattern: '*' }],
        },
        directory: '/tmp/wt',
      }),
    ).toEqual({
      title: 'isolated',
      location: { directory: '/tmp/wt' },
      policy: { tools: { allow: ['bash'] } },
    })
  })

  test('fails closed when session.create includes untranslatable rules', async () => {
    const response = await rewriteShuvcodeSdkRequest(
      new Request('http://127.0.0.1:4096/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          directory: '/tmp/wt',
          permission: [
            { permission: 'external_directory', action: 'deny', pattern: '/repo' },
          ],
        }),
      }),
    )
    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(422)
    expect(await (response as Response).json()).toMatchObject({
      error: { name: 'SessionPolicyUnsupportedError' },
    })
  })

  test('maps session.update title to rename and rejects permission patches', async () => {
    const renamed = await rewriteShuvcodeSdkRequest(
      new Request('http://127.0.0.1:4096/api/session/ses_1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '📁 archived' }),
      }),
    )
    expect(renamed).toBeInstanceOf(Request)
    expect((renamed as Request).method).toBe('POST')
    expect(new URL((renamed as Request).url).pathname).toBe(
      '/api/session/ses_1/rename',
    )
    expect(await (renamed as Request).json()).toEqual({ title: '📁 archived' })

    const rejected = await rewriteShuvcodeSdkRequest(
      new Request('http://127.0.0.1:4096/api/session/ses_1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          permission: [{ permission: 'bash', action: 'allow', pattern: '*' }],
        }),
      }),
    )
    expect(rejected).toBeInstanceOf(Response)
    expect((rejected as Response).status).toBe(422)
  })
})

describe('shuvcode prompt and route rewrite', () => {
  test('translates noReply to resume:false unless resume is explicit', () => {
    expect(rewriteShuvcodePromptBody({ parts: [{ type: 'text', text: 'note' }], noReply: true })).toEqual({
      text: 'note',
      metadata: { noReply: true },
      resume: false,
    })
    expect(
      rewriteShuvcodePromptBody({
        text: 'note',
        noReply: true,
        resume: true,
      }),
    ).toEqual({
      text: 'note',
      metadata: { noReply: true },
      resume: true,
    })
  })

  test('rewrites fork, revert, summarize, permission reply, and question reply', async () => {
    const forked = await rewriteShuvcodeSdkRequest(
      new Request('http://127.0.0.1:4096/api/session/ses_1/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageID: 'msg_9' }),
      }),
    )
    expect(forked).toBeInstanceOf(Request)
    expect(await (forked as Request).json()).toEqual({
      boundary: { type: 'through', messageID: 'msg_9' },
    })

    const reverted = await rewriteShuvcodeSdkRequest(
      new Request('http://127.0.0.1:4096/api/session/ses_1/revert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageID: 'msg_a' }),
      }),
    )
    expect(new URL((reverted as Request).url).pathname).toBe(
      '/api/session/ses_1/revert/stage',
    )

    const compacted = await rewriteShuvcodeSdkRequest(
      new Request('http://127.0.0.1:4096/api/session/ses_1/summarize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerID: 'anthropic', modelID: 'claude', auto: false }),
      }),
    )
    expect(new URL((compacted as Request).url).pathname).toBe(
      '/api/session/ses_1/compact',
    )
    expect(await (compacted as Request).json()).toEqual({})

    rememberShuvcodePermissionRequest({ requestID: 'perm_1', sessionID: 'ses_1' })
    const permissionReply = await rewriteShuvcodeSdkRequest(
      new Request('http://127.0.0.1:4096/api/permission/perm_1/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reply: 'once' }),
      }),
    )
    expect(new URL((permissionReply as Request).url).pathname).toBe(
      '/api/session/ses_1/permission/perm_1/reply',
    )

    rememberShuvcodeForm({
      formID: 'form_1',
      sessionID: 'ses_1',
      fields: [{ key: 'choice', type: 'string' }],
    })
    const questionReply = await rewriteShuvcodeSdkRequest(
      new Request('http://127.0.0.1:4096/api/question/form_1/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: [['Ship it']] }),
      }),
    )
    expect(new URL((questionReply as Request).url).pathname).toBe(
      '/api/session/ses_1/form/form_1/reply',
    )
    expect(await (questionReply as Request).json()).toEqual({
      answer: { choice: 'Ship it' },
    })
  })
})

describe('shuvcode response adapters', () => {
  test('maps provider list into all/connected/default', () => {
    expect(
      mapShuvcodeProviderList({
        providers: [
          { id: 'anthropic', name: 'Anthropic', activation: 'enabled' },
          { id: 'openai', name: 'OpenAI', activation: 'disabled' },
        ],
        models: [
          {
            id: 'claude',
            modelID: 'claude',
            providerID: 'anthropic',
            name: 'Claude',
            time: { released: Date.UTC(2026, 0, 1) },
          },
        ],
        defaultModel: { providerID: 'anthropic', modelID: 'claude' },
      }),
    ).toEqual({
      all: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          activation: 'enabled',
          models: {
            claude: {
              id: 'claude',
              name: 'Claude',
              release_date: '2026-01-01',
              limit: undefined,
              capabilities: undefined,
              status: undefined,
            },
          },
        },
        {
          id: 'openai',
          name: 'OpenAI',
          activation: 'disabled',
          models: {},
        },
      ],
      connected: ['anthropic'],
      default: { anthropic: 'claude' },
    })
  })

  test('maps session messages and revert patches into v1 shapes', () => {
    expect(
      mapShuvcodeSessionMessages([
        { id: 'msg_u', type: 'user', text: 'hi', time: { created: 1 } },
        {
          id: 'msg_a',
          type: 'assistant',
          agent: 'build',
          model: { id: 'claude', providerID: 'anthropic' },
          time: { created: 2, completed: 3 },
          content: [{ type: 'text', text: 'ok' }],
        },
      ]),
    ).toEqual([
      {
        info: { id: 'msg_u', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', text: 'hi' }],
      },
      {
        info: {
          id: 'msg_a',
          role: 'assistant',
          parentID: undefined,
          agent: 'build',
          modelID: 'claude',
          providerID: 'anthropic',
          time: { created: 2, completed: 3 },
          finish: undefined,
          tokens: undefined,
          cost: 0,
        },
        parts: [{ type: 'text', text: 'ok' }],
      },
    ])
    expect(
      mapShuvcodeRevertResponse({
        messageID: 'msg_a',
        files: [{ file: 'a.ts', patch: 'diff --git a/a.ts' }],
      }),
    ).toEqual({
      revert: {
        messageID: 'msg_a',
        files: [{ file: 'a.ts', patch: 'diff --git a/a.ts' }],
        diff: 'diff --git a/a.ts',
      },
    })
  })
})

describe('shuvcode event translation', () => {
  test('emits session.error before idle on execution failure', () => {
    expect(
      translateShuvcodeEvent({
        type: 'session.execution.failed',
        data: {
          sessionID: 'ses_1',
          error: { type: 'ProviderError', message: 'model unavailable' },
        },
      }),
    ).toEqual([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'ProviderError',
            data: { message: 'model unavailable', statusCode: undefined },
          },
        },
      },
      {
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'idle' } },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      },
    ])
  })

  test('tracks tool identity from input.started across the lifecycle', () => {
    const state = createShuvcodeEventTranslateState()
    expect(
      translateShuvcodeEvent(
        {
          type: 'session.tool.input.started',
          data: {
            sessionID: 'ses_1',
            assistantMessageID: 'msg_a',
            id: 'call_1',
            name: 'bash',
          },
        },
        state,
      ),
    ).toEqual([])
    expect(
      translateShuvcodeEvent(
        {
          type: 'session.tool.called',
          created: 20,
          data: {
            sessionID: 'ses_1',
            assistantMessageID: 'msg_a',
            id: 'call_1',
            input: { command: 'ls' },
          },
        },
        state,
      ),
    ).toEqual([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: {
            id: 'tool-ses_1-call_1',
            sessionID: 'ses_1',
            messageID: 'msg_a',
            type: 'tool',
            callID: 'call_1',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: 'ls' },
              time: { start: 20 },
            },
          },
        },
      },
    ])
    expect(
      translateShuvcodeEvent(
        {
          type: 'session.tool.success',
          created: 21,
          data: {
            sessionID: 'ses_1',
            assistantMessageID: 'msg_a',
            id: 'call_1',
            content: [{ type: 'text', text: 'ok' }],
          },
        },
        state,
      ),
    ).toMatchObject([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'ls' },
              output: 'ok',
            },
          },
        },
      },
    ])
  })

  test('translates permission.asked and form.created into Kimaki shapes', () => {
    expect(
      translateShuvcodeEvent({
        type: 'permission.asked',
        data: {
          id: 'perm_1',
          sessionID: 'ses_1',
          action: 'bash',
          resources: ['*.ts'],
          save: [],
        },
      }),
    ).toEqual([
      {
        type: 'permission.asked',
        properties: {
          id: 'perm_1',
          sessionID: 'ses_1',
          permission: 'bash',
          patterns: ['*.ts'],
          always: [],
          metadata: {},
        },
      },
    ])
    expect(
      translateShuvcodeEvent({
        type: 'form.created',
        data: {
          form: {
            id: 'form_1',
            sessionID: 'ses_1',
            title: 'Pick',
            fields: [
              {
                key: 'choice',
                type: 'string',
                title: 'Next step',
                options: [{ label: 'Ship' }, { label: 'Wait' }],
              },
            ],
          },
        },
      }),
    ).toEqual([
      {
        type: 'question.asked',
        properties: {
          id: 'form_1',
          sessionID: 'ses_1',
          questions: [
            {
              question: 'Next step',
              header: 'Next step',
              options: [{ label: 'Ship' }, { label: 'Wait' }],
              multiSelect: false,
            },
          ],
        },
      },
    ])
  })
})
