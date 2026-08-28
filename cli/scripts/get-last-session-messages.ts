#!/usr/bin/env tsx
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
import {
  buildShuvcodeServeArgs,
  getOpencodeServerAuthHeaders,
  resolveOpencodeCommand,
} from '../src/opencode.js'
import { getSpawnCommandAndArgs } from '../src/opencode-command.js'
import { applyShuvcodeServerAuth } from '../src/shuvcode-server-auth.js'

async function getOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => {
          resolve(port)
        })
      } else {
        reject(new Error('Failed to get port'))
      }
    })
    server.on('error', reject)
  })
}

async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
  const headers = getOpencodeServerAuthHeaders()
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers,
      })
      if (response.status >= 200 && response.status < 300) {
        return true
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(
    `Server did not start on port ${port} after ${maxAttempts} seconds`,
  )
}

async function getLastSessionMessages() {
  const port = await getOpenPort()
  const baseUrl = `http://127.0.0.1:${port}`

  console.log(`Starting shuvcode server on port ${port}...`)

  const password =
    process.env.OPENCODE_PASSWORD ||
    process.env.OPENCODE_SERVER_PASSWORD ||
    randomBytes(16).toString('hex')
  applyShuvcodeServerAuth({
    auth: { username: 'opencode', password },
  })

  const directory = process.cwd()
  const { command, args, windowsVerbatimArguments } = getSpawnCommandAndArgs({
    resolvedCommand: resolveOpencodeCommand(),
    baseArgs: buildShuvcodeServeArgs({ port }),
  })

  const serverProcess = spawn(command, args, {
    stdio: 'pipe',
    detached: false,
    cwd: directory,
    windowsVerbatimArguments,
    env: {
      ...process.env,
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_PORT: port.toString(),
    },
  })

  serverProcess.stdout?.on('data', (data) => {
    console.log(`[shuvcode]: ${data.toString().trim()}`)
  })

  serverProcess.stderr?.on('data', (data) => {
    console.error(`[shuvcode error]: ${data.toString().trim()}`)
  })

  serverProcess.on('error', (error) => {
    console.error('Failed to start shuvcode server:', error)
    process.exit(1)
  })

  serverProcess.on('exit', (code) => {
    console.log(`shuvcode server exited with code: ${code}`)
  })

  await waitForServer(port)

  const client = createOpencodeClient({
    baseUrl,
    directory,
    headers: getOpencodeServerAuthHeaders(),
  })

  console.log('=== Fetching Last Session Messages ===\n')

  try {
    const currentProjectResponse = await client.project.current()
    if (!currentProjectResponse.data) {
      console.error('Failed to fetch current project')
      return
    }
    const currentProject = currentProjectResponse.data
    console.log(`Current Project: ${currentProject.id}`)
    console.log(`Worktree: ${currentProject.worktree}\n`)

    const sessionsResponse = await client.session.list({ directory })
    if (!sessionsResponse.data) {
      console.error('Failed to fetch sessions')
      return
    }

    const projectSessions = sessionsResponse.data.filter(
      (s) => s.projectID === currentProject.id,
    )

    if (projectSessions.length === 0) {
      console.log('No sessions found for the current project')
      return
    }

    const latestSession = projectSessions.sort(
      (a, b) => b.time.updated - a.time.updated,
    )[0]

    console.log(`Latest Session: "${latestSession.title}"`)
    console.log(`Session ID: ${latestSession.id}`)
    console.log(
      `Last Updated: ${new Date(latestSession.time.updated).toLocaleString()}\n`,
    )

    const messagesResponse = await client.session.messages({
      sessionID: latestSession.id,
      directory,
    })

    if (!messagesResponse.data) {
      console.error('Failed to fetch session messages')
      return
    }

    const messages = messagesResponse.data
    console.log(`Found ${messages.length} message(s) in the session\n`)

    console.log('=== Session Messages (JSON) ===\n')
    console.log(JSON.stringify(messages, null, 2))
  } catch (error) {
    console.error('Error fetching session messages:', error)
    serverProcess.kill()
    process.exit(1)
  } finally {
    serverProcess.kill()
    process.exit(0)
  }
}

getLastSessionMessages().catch(console.error)
