import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  SHUVCODE_BIN_NAME,
  buildShuvcodeServeArgs,
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

  test('serve args are the v2-safe port pair', () => {
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

  test('binary name is shuvcode', () => {
    expect(SHUVCODE_BIN_NAME).toBe('shuvcode')
  })
})
