import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  SHUVCODE_BIN_NAME,
  buildShuvcodeServeArgs,
  ensureShuvcodeServerPassword,
  getOpencodeServerAuthHeaders,
  getShuvcodeCandidatePaths,
  getShuvcodePathOverride,
} from './opencode.js'

describe('shuvcode binary resolution helpers', () => {
  test('prefers SHUVCODE_PATH over OPENCODE_PATH', () => {
    expect(
      getShuvcodePathOverride({
        env: {
          SHUVCODE_PATH: '/opt/shuvcode',
          OPENCODE_PATH: '/opt/opencode',
        },
      }),
    ).toBe('/opt/shuvcode')
  })

  test('accepts OPENCODE_PATH when SHUVCODE_PATH is unset', () => {
    expect(
      getShuvcodePathOverride({
        env: {
          OPENCODE_PATH: '/opt/shuvcode',
        },
      }),
    ).toBe('/opt/shuvcode')
  })

  test('ignores blank overrides', () => {
    expect(
      getShuvcodePathOverride({
        env: {
          SHUVCODE_PATH: '   ',
        },
      }),
    ).toBeUndefined()
  })

  test('unix candidate paths are shuvcode-only', () => {
    const home = '/home/user'
    const paths = getShuvcodeCandidatePaths({
      home,
      platform: 'linux',
    })
    expect(paths).toEqual([
      path.join(home, '.bun', 'bin', 'shuvcode'),
      path.join(home, '.local', 'bin', 'shuvcode'),
      path.join('/usr', 'local', 'bin', 'shuvcode'),
    ])
    expect(paths.some((candidate) => candidate.includes('opencode'))).toBe(false)
  })

  test('windows candidate paths are shuvcode-only', () => {
    const home = 'C:\\Users\\user'
    const paths = getShuvcodeCandidatePaths({
      home,
      platform: 'win32',
    })
    expect(paths).toEqual([
      path.join(home, '.local', 'bin', 'shuvcode.exe'),
      path.join(home, '.bun', 'bin', 'shuvcode.exe'),
      path.join(home, 'AppData', 'Roaming', 'npm', 'shuvcode.cmd'),
    ])
    expect(paths.some((candidate) => candidate.includes('opencode'))).toBe(false)
  })

  test('serve args are only the v2-safe port pair', () => {
    expect(buildShuvcodeServeArgs({ port: 4096 })).toEqual([
      'serve',
      '--port',
      '4096',
    ])
    expect(buildShuvcodeServeArgs({ port: 4096 }).join(' ')).not.toContain(
      'print-logs',
    )
    expect(buildShuvcodeServeArgs({ port: 4096 }).join(' ')).not.toContain(
      'log-level',
    )
  })

  test('generates a shared server password when none is set', () => {
    const env: NodeJS.ProcessEnv = {}
    const password = ensureShuvcodeServerPassword({ env })
    expect(password.length).toBeGreaterThan(16)
    expect(env.OPENCODE_PASSWORD).toBe(password)
    expect(env.OPENCODE_SERVER_PASSWORD).toBe(password)
  })

  test('reuses OPENCODE_PASSWORD when already set', () => {
    const env: NodeJS.ProcessEnv = { OPENCODE_PASSWORD: 'existing-secret' }
    expect(ensureShuvcodeServerPassword({ env })).toBe('existing-secret')
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('existing-secret')
  })

  test('auth headers use the opencode username and password', () => {
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousUser = process.env.OPENCODE_SERVER_USERNAME
    process.env.OPENCODE_SERVER_PASSWORD = 'secret'
    delete process.env.OPENCODE_SERVER_USERNAME
    expect(getOpencodeServerAuthHeaders()).toEqual({
      Authorization: `Basic ${Buffer.from('opencode:secret').toString('base64')}`,
    })
    if (previousPassword === undefined) {
      delete process.env.OPENCODE_SERVER_PASSWORD
    } else {
      process.env.OPENCODE_SERVER_PASSWORD = previousPassword
    }
    if (previousUser === undefined) {
      delete process.env.OPENCODE_SERVER_USERNAME
    } else {
      process.env.OPENCODE_SERVER_USERNAME = previousUser
    }
  })

  test('binary name is shuvcode', () => {
    expect(SHUVCODE_BIN_NAME).toBe('shuvcode')
  })
})
