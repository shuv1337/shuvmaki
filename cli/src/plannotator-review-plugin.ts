// Associates each Plannotator child process with the OpenCode session whose
// submit_plan tool started it. PLANNOTATOR_BIN is process-global, so starts are
// serialized only until the child claims its unique executable.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from '@opencode-ai/plugin'
import { setDataDir } from './config.js'
import { createPluginLogger, setPluginLogFilePath } from './plugin-logger.js'
import { PlannotatorStartGate } from './plannotator-start-gate.js'

const logger = createPluginLogger('PLANNOTATOR')
const CLAIM_TIMEOUT_MS = 15_000
const CLAIM_POLL_MS = 25

const startGate = new PlannotatorStartGate()

async function waitForClaim({ claimFile, sessionId }: { claimFile: string; sessionId: string }) {
  const deadline = Date.now() + CLAIM_TIMEOUT_MS
  const claimedFile = `${claimFile}.claimed`
  while (Date.now() < deadline && !fs.existsSync(claimedFile)) {
    await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS))
  }

  const claimed = fs.existsSync(claimedFile)
  if (!claimed) {
    logger.warn(`Timed out waiting for Plannotator process for session ${sessionId}`)
  }
  const removeResult = await Promise.all([
    fs.promises.rm(claimFile, { force: true }),
    fs.promises.rm(claimedFile, { force: true }),
    fs.promises.rm(`${claimFile}.sh`, { force: true }),
  ]).catch((cause) => new Error('Failed to remove Plannotator claim files', { cause }))
  if (removeResult instanceof Error) logger.warn(removeResult.message)
}

function quotePosixShellSegment(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export const plannotatorReviewPlugin: Plugin = async () => {
  const dataDir = process.env.KIMAKI_DATA_DIR
  const basePlannotatorBin = process.env.PLANNOTATOR_BIN
  if (dataDir) {
    setDataDir(dataDir)
    setPluginLogFilePath(dataDir)
  }

  return {
    'tool.execute.before': async (input) => {
      if (input.tool !== 'submit_plan') return
      if (process.env.KIMAKI_PLANNOTATOR_TUNNEL !== '1') return
      if (!dataDir || !basePlannotatorBin) return

      const { getThreadIdBySessionId } = await import('./database.js')
      const threadId = await getThreadIdBySessionId(input.sessionID)
      const releaseStart = await startGate.acquire()
      let claimWaiterOwnsRelease = false
      try {
        if (!threadId) return
        const claimDirectory = path.join(dataDir, 'plannotator-claims')
        const setupResult = await fs.promises
          .mkdir(claimDirectory, { recursive: true })
          .catch((cause) => new Error('Failed to create Plannotator claim directory', { cause }))
        if (setupResult instanceof Error) {
          logger.warn(setupResult.message)
          throw setupResult
        }
        const claimFile = path.join(claimDirectory, crypto.randomUUID())
        const ticketResult = await fs.promises
          .writeFile(claimFile, JSON.stringify({ sessionId: input.sessionID }), { mode: 0o600 })
          .catch((cause) => new Error('Failed to write Plannotator claim ticket', { cause }))
        if (ticketResult instanceof Error) {
          logger.warn(ticketResult.message)
          throw ticketResult
        }
        const attemptShim = `${claimFile}.sh`
        const shimResult = await fs.promises
          .writeFile(
            attemptShim,
            [
              '#!/bin/sh',
              `export KIMAKI_PLANNOTATOR_CLAIM_FILE=${quotePosixShellSegment(claimFile)}`,
              `exec ${quotePosixShellSegment(basePlannotatorBin)} "$@"`,
              '',
            ].join('\n'),
            { mode: 0o700 },
          )
          .catch((cause) => new Error('Failed to write Plannotator attempt shim', { cause }))
        if (shimResult instanceof Error) {
          const cleanupResult = await fs.promises
            .rm(claimFile, { force: true })
            .catch((cause) => new Error('Failed to remove Plannotator claim ticket', { cause }))
          if (cleanupResult instanceof Error) logger.warn(cleanupResult.message)
          logger.warn(shimResult.message)
          throw shimResult
        }
        process.env.PLANNOTATOR_BIN = attemptShim
        claimWaiterOwnsRelease = true
        void waitForClaim({ claimFile, sessionId: input.sessionID })
          .catch((cause) => {
            logger.warn(new Error('Plannotator claim waiter failed', { cause }).message)
          })
          .finally(() => {
            if (process.env.PLANNOTATOR_BIN === attemptShim) {
              process.env.PLANNOTATOR_BIN = basePlannotatorBin
            }
            releaseStart()
          })
      } finally {
        if (!claimWaiterOwnsRelease) releaseStart()
      }
    },
  }
}
