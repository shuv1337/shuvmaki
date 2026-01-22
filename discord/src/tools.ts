// Voice assistant tool definitions for the GenAI worker.
// Provides tools for managing OpenCode sessions (create, submit, abort),
// listing chats, searching files, and reading session messages.

import { tool } from 'ai'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import {
  createOpencodeClient,
  type OpencodeClient,
  type AssistantMessage,
  type Provider,
} from '@opencode-ai/sdk'
import { createLogger } from './logger.js'
import * as errore from 'errore'

const toolsLogger = createLogger('TOOLS')

import { ShareMarkdown } from './markdown.js'
import { formatDistanceToNow } from './utils.js'
import pc from 'picocolors'
import { initializeOpencodeForDirectory, getOpencodeSystemMessage } from './discord-bot.js'

export async function getTools({
  onMessageCompleted,
  directory,
}: {
  directory: string
  onMessageCompleted?: (params: {
    sessionId: string
    messageId: string
    data?: { info: AssistantMessage }
    error?: unknown
    markdown?: string
  }) => void
}) {
  const getClient = await initializeOpencodeForDirectory(directory)
  if (errore.isError(getClient)) {
    throw new Error(getClient.message)
  }
  const client = getClient()

  const markdownRenderer = new ShareMarkdown(client)

  const providersResponse = await client.config.providers({})
  const providers: Provider[] = providersResponse.data?.providers || []

  // Helper: get last assistant model for a session (non-summary)
  const getSessionModel = async (
    sessionId: string,
  ): Promise<{ providerID: string; modelID: string } | undefined> => {
    const res = await getClient().session.messages({ path: { id: sessionId } })
    const data = res.data
    if (!data || data.length === 0) return undefined
    for (let i = data.length - 1; i >= 0; i--) {
      const info = data?.[i]?.info
      if (info?.role === 'assistant') {
        const ai = info as AssistantMessage
        if (!ai.summary && ai.providerID && ai.modelID) {
          return { providerID: ai.providerID, modelID: ai.modelID }
        }
      }
    }
    return undefined
  }

  const tools = {
    submitMessage: tool({
      description:
        'Submit a message to an existing chat session. Does not wait for the message to complete',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to send message to'),
        message: z.string().describe('The message text to send'),
      }),
      execute: async ({ sessionId, message }) => {
        const sessionModel = await getSessionModel(sessionId)

        // do not await
        getClient()
          .session.prompt({
            path: { id: sessionId },
            body: {
              parts: [{ type: 'text', text: message }],
              model: sessionModel,
              system: getOpencodeSystemMessage({ sessionId }),
            },
          })
          .then(async (response) => {
            const markdownResult = await markdownRenderer.generate({
              sessionID: sessionId,
              lastAssistantOnly: true,
            })
            onMessageCompleted?.({
              sessionId,
              messageId: '',
              data: response.data,
              markdown: errore.unwrapOr(markdownResult, ''),
            })
          })
          .catch((error) => {
            onMessageCompleted?.({
              sessionId,
              messageId: '',
              error,
            })
          })
        return {
          success: true,
          sessionId,
          directive: 'Tell user that message has been sent successfully',
        }
      },
    }),

    createNewChat: tool({
      description:
        'Start a new chat session with an initial message. Does not wait for the message to complete',
      inputSchema: z.object({
        message: z.string().describe('The initial message to start the chat with'),
      }),
      execute: async ({ message }) => {
        const sessionResponse = await client.session.create({ body: { title: message } })
        const sessionId = sessionResponse.data?.id

        if (!sessionId) {
          throw new Error('Failed to create session')
        }

        // do not await
        getClient()
          .session.prompt({
            path: { id: sessionId },
            body: {
              parts: [{ type: 'text', text: message }],
              system: getOpencodeSystemMessage({ sessionId }),
            },
          })
          .then(async (response) => {
            const markdownResult = await markdownRenderer.generate({
              sessionID: sessionId,
              lastAssistantOnly: true,
            })
            onMessageCompleted?.({
              sessionId,
              messageId: '',
              data: response.data,
              markdown: errore.unwrapOr(markdownResult, ''),
            })
          })
          .catch((error) => {
            onMessageCompleted?.({
              sessionId,
              messageId: '',
              error,
            })
          })

        return {
          success: true,
          sessionId,
          directive: 'Tell user that new chat session has been created',
        }
      },
    }),

    listChats: tool({
      description: 'List all available chat sessions',
      inputSchema: z.object({
        limit: z.number().optional().describe('Number of sessions to return (default: 10)'),
      }),
      execute: async ({ limit = 10 }) => {
        const response = await client.session.list()
        const sessions = response.data || []

        const sessionList = sessions.slice(0, limit).map((session) => {
          return {
            id: session.id,
            title: session.title || 'Untitled',
            created: formatDistanceToNow(new Date(session.time.created)),
          }
        })

        return {
          sessions: sessionList,
        }
      },
    }),

    readMessages: tool({
      description: 'Read messages from a chat session',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to read messages from'),
        lastAssistantOnly: z
          .boolean()
          .optional()
          .describe('If true, return only the last assistant message'),
      }),
      execute: async ({ sessionId, lastAssistantOnly = false }) => {
        const markdownResult = await markdownRenderer.generate({
          sessionID: sessionId,
          lastAssistantOnly,
        })

        return {
          markdown: errore.unwrapOr(markdownResult, ''),
        }
      },
    }),

    abortSession: tool({
      description: 'Abort an active chat session',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to abort'),
      }),
      execute: async ({ sessionId }) => {
        await getClient().session.abort({ path: { id: sessionId } })
        return { success: true }
      },
    }),
  }

  return tools
}

export async function startStandaloneToolsServer({
  port,
  directory,
  onReady,
}: {
  port?: number
  directory: string
  onReady?: () => void
}) {
  const serverPort = port || 7880
  const server = net.createServer()

  const serverProcess = await new Promise<ChildProcess>((resolve) => {
    server.listen(serverPort, async () => {
      toolsLogger.log(`Starting tools server on port ${serverPort}`)
      const worker = spawn('bun', ['src/genai-worker.ts'], {
        env: {
          ...process.env,
          GENAI_TOOLS_PORT: serverPort.toString(),
          GENAI_TOOLS_DIR: directory,
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      })

      resolve(worker)
    })
  })

  onReady?.()
  return serverProcess
}

export async function createStandaloneToolsServer({
  port,
  directory,
}: {
  port?: number
  directory: string
}) {
  const serverPort = port || 7880
  const server = net.createServer()

  return new Promise<OpencodeClient>((resolve) => {
    server.listen(serverPort, async () => {
      toolsLogger.log(`Starting tools server on port ${serverPort}`)

      const client = createOpencodeClient({
        baseUrl: `http://127.0.0.1:${serverPort}`,
      })

      resolve(client)
    })
  })
}

export async function isToolsServerRunning({ port }: { port: number }) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1')
    socket.on('connect', () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => {
      resolve(false)
    })
  })
}
