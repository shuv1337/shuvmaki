import { describe, expect, test } from 'vitest'
import {
  buildPlannotatorChildEnv,
  claimPlannotatorStart,
  createPlannotatorTunnelId,
  createPlannotatorTunnelPassword,
} from './plannotator-tunnel.js'
import { ensurePlannotatorCommandShim } from './opencode-command.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('Plannotator tunnel bridge', () => {
  test('uses an unguessable 128-bit tunnel id', () => {
    expect(createPlannotatorTunnelId()).toMatch(/^[a-f0-9]{32}$/)
    expect(createPlannotatorTunnelPassword()).toMatch(/^[a-f0-9]{32}$/)
  })

  test('isolates the real Plannotator child from the bridge environment', () => {
    expect(
      buildPlannotatorChildEnv({
        env: {
          PLANNOTATOR_BIN: '/tmp/plannotator-kimaki',
          KIMAKI_PLANNOTATOR_CLAIM_FILE: '/tmp/claim',
          KIMAKI_PLANNOTATOR_REAL_BIN: '/usr/local/bin/plannotator',
          KIMAKI_PLANNOTATOR_TUNNEL: '1',
        },
        port: 19432,
        readyFile: '/tmp/private-ready',
        tunnelUrl: 'https://review-tunnel.shuv.bot',
      }),
    ).toMatchInlineSnapshot(`
      {
        "PLANNOTATOR_PORT": "19432",
        "PLANNOTATOR_READY_FILE": "/tmp/private-ready",
        "PLANNOTATOR_REMOTE": "0",
        "PLANNOTATOR_SKIP_BROWSER_OPEN": "1",
        "TRAFORO_URL": "https://review-tunnel.shuv.bot",
      }
    `)
  })

  test('creates a shim that claims the review before starting Kimaki', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-plannotator-shim-'))
    const shim = ensurePlannotatorCommandShim({ shimDirectory: directory, platform: 'linux' })
    if (shim instanceof Error) throw shim
    expect(fs.readFileSync(shim, 'utf8')).toMatchInlineSnapshot(`
      "#!/bin/sh
      exec '${directory}/kimaki' plannotator-tunnel -- \"$@\"
      "
    `)
    fs.rmSync(directory, { recursive: true, force: true })
  })

  test('fails closed instead of returning an unspawnable Windows cmd shim', () => {
    const shim = ensurePlannotatorCommandShim({
      shimDirectory: 'C:\\kimaki\\bin',
      platform: 'win32',
    })
    expect(shim).toMatchObject({
      message: 'Remote Plannotator reviews are not yet supported on Windows',
    })
  })

  test('only claims files inside the data directory claim folder', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-plannotator-claim-'))
    const claimDirectory = path.join(dataDir, 'plannotator-claims')
    fs.mkdirSync(claimDirectory)
    const validClaim = path.join(claimDirectory, '123e4567-e89b-12d3-a456-426614174000')
    fs.writeFileSync(validClaim, JSON.stringify({ sessionId: 'ses_test123' }))
    expect(claimPlannotatorStart({ dataDir, claimFile: validClaim })).toEqual({
      sessionId: 'ses_test123',
    })
    expect(fs.existsSync(`${validClaim}.claimed`)).toBe(true)
    expect(claimPlannotatorStart({ dataDir, claimFile: validClaim })).toMatchObject({
      message: 'Failed to claim the Plannotator start',
    })
    expect(
      claimPlannotatorStart({
        dataDir,
        claimFile: path.join(dataDir, 'outside'),
      }),
    ).toMatchObject({ message: 'Invalid Plannotator claim path' })
    expect(claimPlannotatorStart({ dataDir, claimFile: undefined })).toMatchObject({
      message: 'Missing Plannotator claim path',
    })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})
