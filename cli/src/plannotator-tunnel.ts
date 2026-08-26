import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import util from 'node:util'
import { spawn, type ChildProcess } from 'node:child_process'
import * as errore from 'errore'
import { TunnelClient } from 'traforo/client'
import { setDataDir } from './config.js'
import {
  cancelPendingIpcRequest,
  createIpcRequest,
  getIpcRequestById,
  getThreadIdBySessionId,
} from './database.js'
import { getKimakiTunnelUrlTemplate } from './tunnel-config.js'

const READY_TIMEOUT_MS = 15_000
const DISCORD_DELIVERY_TIMEOUT_MS = 15_000
const DISCORD_PROCESSING_TIMEOUT_MS = 60_000
export const PLANNOTATOR_REVIEW_TIMEOUT_MS = 60 * 60 * 1000

class PlannotatorTunnelError extends errore.createTaggedError({
  name: 'PlannotatorTunnelError',
  message: '$reason',
}) {}

export function createPlannotatorTunnelId() {
  return crypto.randomBytes(16).toString('hex')
}

export function createPlannotatorTunnelPassword() {
  return crypto.randomBytes(16).toString('hex')
}

export function claimPlannotatorStart({
  dataDir,
  claimFile,
}: {
  dataDir: string
  claimFile: string | undefined
}) {
  if (!claimFile) return new PlannotatorTunnelError({ reason: 'Missing Plannotator claim path' })
  const claimDirectory = path.resolve(dataDir, 'plannotator-claims')
  const resolvedClaimFile = path.resolve(claimFile)
  if (path.dirname(resolvedClaimFile) !== claimDirectory) {
    return new PlannotatorTunnelError({ reason: 'Invalid Plannotator claim path' })
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path.basename(resolvedClaimFile),
    )
  ) {
    return new PlannotatorTunnelError({ reason: 'Invalid Plannotator claim id' })
  }
  return errore.try(
    () => {
      const ticket = JSON.parse(fs.readFileSync(resolvedClaimFile, 'utf8')) as {
        sessionId?: unknown
      }
      if (typeof ticket.sessionId !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(ticket.sessionId)) {
        return new PlannotatorTunnelError({ reason: 'Invalid Plannotator claim ticket' })
      }
      const claimHandle = fs.openSync(`${resolvedClaimFile}.claimed`, 'wx', 0o600)
      fs.closeSync(claimHandle)
      return { sessionId: ticket.sessionId }
    },
    (cause) =>
      new PlannotatorTunnelError({ reason: 'Failed to claim the Plannotator start', cause }),
  )
}

export function buildPlannotatorChildEnv({
  env,
  port,
  readyFile,
  tunnelUrl,
}: {
  env: NodeJS.ProcessEnv
  port: number
  readyFile: string
  tunnelUrl: string
}) {
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PLANNOTATOR_PORT: String(port),
    // Keep the review listener on loopback. Trafóro is the only public ingress,
    // matching Plannotator's own loopback-only --tailscale transport.
    PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_READY_FILE: readyFile,
    TRAFORO_URL: tunnelUrl,
  }
  delete childEnv.PLANNOTATOR_BIN
  delete childEnv.KIMAKI_PLANNOTATOR_CLAIM_FILE
  delete childEnv.KIMAKI_PLANNOTATOR_REAL_BIN
  delete childEnv.KIMAKI_PLANNOTATOR_TUNNEL
  return childEnv
}

async function getAvailablePort() {
  return await new Promise<number | PlannotatorTunnelError>((resolve) => {
    const server = net.createServer()
    server.once('error', (cause) => {
      resolve(new PlannotatorTunnelError({ reason: 'Failed to reserve a local port', cause }))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((cause) => {
        if (cause) {
          resolve(
            new PlannotatorTunnelError({
              reason: 'Failed to release the reserved local port',
              cause,
            }),
          )
          return
        }
        if (!port) {
          resolve(
            new PlannotatorTunnelError({ reason: 'Failed to determine the reserved local port' }),
          )
          return
        }
        resolve(port)
      })
    })
  })
}

async function waitForReadyFile({
  readyFile,
  port,
  child,
}: {
  readyFile: string
  port: number
  child: ChildProcess
}) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return new PlannotatorTunnelError({
        reason: `Plannotator exited before opening port ${port}`,
      })
    }
    if (fs.existsSync(readyFile)) {
      const contents = fs.readFileSync(readyFile, 'utf8')
      const isReady = contents.split(/\r?\n/).some((line) => {
        if (!line) return false
        const metadata = errore.try(() => JSON.parse(line) as { port?: unknown })
        return !(metadata instanceof Error) && metadata.port === port
      })
      if (isReady) return null
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return new PlannotatorTunnelError({ reason: `Timed out waiting for Plannotator on port ${port}` })
}

function waitForChild(child: ChildProcess) {
  return new Promise<number>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode ?? 1)
      return
    }
    child.once('close', (code) => resolve(code ?? 1))
  })
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    waitForChild(child),
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ])
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGKILL')
  await waitForChild(child)
}

async function waitForDiscordDelivery({
  requestId,
  child,
}: {
  requestId: string
  child: ChildProcess
}) {
  const deadline = Date.now() + DISCORD_DELIVERY_TIMEOUT_MS
  let processingDeadline = Number.POSITIVE_INFINITY
  let dispatcherOwnsRequest = false
  while (true) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return new PlannotatorTunnelError({
        reason: 'Plannotator exited before the review link reached Discord',
      })
    }
    const request = await getIpcRequestById({ id: requestId }).catch(
      (cause) =>
        new PlannotatorTunnelError({ reason: 'Failed to read review link delivery', cause }),
    )
    if (request instanceof Error) return request
    if (request?.status === 'cancelled') {
      return new PlannotatorTunnelError({ reason: 'Review link delivery was cancelled' })
    }
    const responseText = request?.response
    if (responseText) {
      const response = errore.try(
        () => JSON.parse(responseText) as { ok?: boolean; error?: string },
        (cause) =>
          new PlannotatorTunnelError({ reason: 'Invalid review delivery response', cause }),
      )
      if (response instanceof Error) return response
      if (response.error) return new PlannotatorTunnelError({ reason: response.error })
      if (response.ok) return null
    }
    if (Date.now() >= deadline && !dispatcherOwnsRequest) {
      const deliveryError = new PlannotatorTunnelError({
        reason: 'Timed out delivering the review link to Discord',
      })
      const cancelled = await cancelPendingIpcRequest({
        id: requestId,
        response: JSON.stringify({ error: deliveryError.message }),
      }).catch(
        (cause) =>
          new PlannotatorTunnelError({ reason: 'Failed to cancel review link delivery', cause }),
      )
      if (cancelled instanceof Error) return cancelled
      if (cancelled) return deliveryError
      // The poller won the pending -> processing race. Let it finish instead of
      // tearing down a tunnel whose link may already be in Discord.
      dispatcherOwnsRequest = true
      processingDeadline = Date.now() + DISCORD_PROCESSING_TIMEOUT_MS
    }
    if (dispatcherOwnsRequest && Date.now() >= processingDeadline) {
      return new PlannotatorTunnelError({
        reason: 'Timed out waiting for Discord to finish sending the review link',
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function pipeProcessStreams(child: ChildProcess) {
  process.stdin.pipe(child.stdin!)
  child.stdout!.pipe(process.stdout)
  child.stderr!.pipe(process.stderr)
  child.stdin!.on('error', (cause: NodeJS.ErrnoException) => {
    if (cause.code === 'EPIPE') return
    process.stderr.write(`Plannotator stdin failed: ${cause.message}\n`)
  })
  return () => {
    process.stdin.unpipe(child.stdin!)
    process.stdin.pause()
  }
}

async function runPlannotatorDirect({ args }: { args: string[] }) {
  const realPlannotatorBin = process.env.KIMAKI_PLANNOTATOR_REAL_BIN
  if (!realPlannotatorBin) {
    return new PlannotatorTunnelError({ reason: 'Real Plannotator binary path is missing' })
  }
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  delete childEnv.PLANNOTATOR_BIN
  delete childEnv.KIMAKI_PLANNOTATOR_CLAIM_FILE
  delete childEnv.KIMAKI_PLANNOTATOR_REAL_BIN
  delete childEnv.KIMAKI_PLANNOTATOR_TUNNEL
  const child = spawn(realPlannotatorBin, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const cleanupStreams = pipeProcessStreams(child)
  const childError = new Promise<PlannotatorTunnelError>((resolve) => {
    child.once('error', (cause) => {
      resolve(new PlannotatorTunnelError({ reason: 'Failed to start Plannotator', cause }))
    })
  })
  const result = await Promise.race([waitForChild(child), childError])
  cleanupStreams()
  return result
}

export async function runPlannotatorTunnel({ args }: { args: string[] }) {
  const dataDir = process.env.KIMAKI_DATA_DIR
  if (dataDir) setDataDir(dataDir)
  const claimFile = process.env.KIMAKI_PLANNOTATOR_CLAIM_FILE
  if (!claimFile) return await runPlannotatorDirect({ args })
  if (!dataDir) return new PlannotatorTunnelError({ reason: 'KIMAKI_DATA_DIR is required' })
  const claimResult = claimPlannotatorStart({
    dataDir,
    claimFile,
  })
  if (claimResult instanceof Error) return claimResult
  const sessionId = claimResult.sessionId
  const realPlannotatorBin = process.env.KIMAKI_PLANNOTATOR_REAL_BIN
  if (!realPlannotatorBin) {
    return new PlannotatorTunnelError({ reason: 'Real Plannotator binary path is missing' })
  }

  const port = await getAvailablePort()
  if (port instanceof Error) return port

  const tunnelId = createPlannotatorTunnelId()
  const tunnelPassword = createPlannotatorTunnelPassword()
  const tunnelClient = new TunnelClient({
    localPort: port,
    localHost: '127.0.0.1',
    tunnelId,
    password: tunnelPassword,
    urlTemplate: getKimakiTunnelUrlTemplate(),
  })
  const privateReadyFile = path.join(os.tmpdir(), `kimaki-plannotator-${crypto.randomUUID()}.jsonl`)
  const publicReadyFile = process.env.PLANNOTATOR_READY_FILE
  const child = spawn(realPlannotatorBin, args, {
    cwd: process.cwd(),
    env: buildPlannotatorChildEnv({
      env: process.env,
      port,
      readyFile: privateReadyFile,
      tunnelUrl: tunnelClient.url,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const cleanupStreams = pipeProcessStreams(child)

  const childError = new Promise<PlannotatorTunnelError>((resolve) => {
    child.once('error', (cause) => {
      resolve(new PlannotatorTunnelError({ reason: 'Failed to start Plannotator', cause }))
    })
  })
  const readyResult = await Promise.race([
    waitForReadyFile({ readyFile: privateReadyFile, port, child }),
    childError,
  ])
  if (readyResult instanceof Error) {
    cleanupStreams()
    await stopChild(child)
    fs.rmSync(privateReadyFile, { force: true })
    return readyResult
  }

  const restoreConsoleLog = (() => {
    const original = console.log
    console.log = (...values: unknown[]) => {
      process.stderr.write(`${util.format(...values)}\n`)
    }
    return () => {
      console.log = original
    }
  })()
  const connected = await tunnelClient
    .connect()
    .catch(
      (cause) =>
        new PlannotatorTunnelError({ reason: 'Failed to expose the Plannotator review', cause }),
    )
  if (connected instanceof Error) {
    cleanupStreams()
    restoreConsoleLog()
    await stopChild(child)
    fs.rmSync(privateReadyFile, { force: true })
    return connected
  }

  const closeTunnel = () => tunnelClient.close()
  const terminate = (signal: NodeJS.Signals) => {
    closeTunnel()
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  const handleSigint = () => terminate('SIGINT')
  const handleSigterm = () => terminate('SIGTERM')
  process.once('SIGINT', handleSigint)
  process.once('SIGTERM', handleSigterm)

  const timeout = setTimeout(() => {
    terminate('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 1000).unref()
  }, PLANNOTATOR_REVIEW_TIMEOUT_MS)
  timeout.unref()

  try {
    if (publicReadyFile) {
      const readyResult = errore.try(
        () =>
          fs.appendFileSync(
            publicReadyFile,
            `${JSON.stringify({ url: tunnelClient.url, isRemote: true, port })}\n`,
          ),
        (cause) =>
          new PlannotatorTunnelError({ reason: 'Failed to publish the review URL', cause }),
      )
      if (readyResult instanceof Error) return readyResult
    }

    const threadId = await getThreadIdBySessionId(sessionId).catch(
      (cause) =>
        new PlannotatorTunnelError({
          reason: 'Failed to resolve the Discord review thread',
          cause,
        }),
    )
    if (threadId instanceof Error) return threadId
    if (!threadId) {
      return new PlannotatorTunnelError({ reason: 'Could not find the Discord review thread' })
    }
    const ipcResult = await createIpcRequest({
      type: 'plannotator_review',
      sessionId,
      threadId,
      payload: JSON.stringify({
        url: tunnelClient.url,
        password: tunnelPassword,
      }),
    }).catch(
      (cause) =>
        new PlannotatorTunnelError({ reason: 'Failed to queue the Discord review link', cause }),
    )
    if (ipcResult instanceof Error) return ipcResult
    const deliveryResult = await waitForDiscordDelivery({ requestId: ipcResult.id, child })
    if (deliveryResult instanceof Error) return deliveryResult

    return await waitForChild(child)
  } finally {
    clearTimeout(timeout)
    closeTunnel()
    await stopChild(child)
    process.removeListener('SIGINT', handleSigint)
    process.removeListener('SIGTERM', handleSigterm)
    restoreConsoleLog()
    cleanupStreams()
    const removeResult = errore.try(
      () => fs.rmSync(privateReadyFile, { force: true }),
      (cause) => new PlannotatorTunnelError({ reason: 'Failed to remove review state', cause }),
    )
    if (removeResult instanceof Error) process.stderr.write(`${removeResult.message}\n`)
  }
}
