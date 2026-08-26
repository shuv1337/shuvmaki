import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setDataDir } from './config.js'
import {
  ALLOWED_USER_IDS_ENV,
  ALLOWED_USERS_FILENAME,
  allowedUsersFilePath,
  isAllowedUserId,
  loadAllowedUserIds,
  seedGuildOwner,
} from './allowed-users.js'

describe('allowed-users', () => {
  let tmpDir = ''
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env[ALLOWED_USER_IDS_ENV]
    delete process.env[ALLOWED_USER_IDS_ENV]
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-allowed-users-'))
    setDataDir(tmpDir)
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ALLOWED_USER_IDS_ENV]
    } else {
      process.env[ALLOWED_USER_IDS_ENV] = originalEnv
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('load returns empty when file and env are missing', () => {
    expect(loadAllowedUserIds()).toEqual([])
    expect(isAllowedUserId('user-1')).toBe(false)
  })

  test('seedGuildOwner writes owner on first call and is idempotent', () => {
    seedGuildOwner('owner-id')
    expect(fs.readFileSync(allowedUsersFilePath(), 'utf8')).toBe(
      `${JSON.stringify({ userIds: ['owner-id'] }, null, 2)}\n`,
    )
    expect(loadAllowedUserIds()).toEqual(['owner-id'])
    expect(isAllowedUserId('owner-id')).toBe(true)

    seedGuildOwner('other-owner')
    expect(loadAllowedUserIds()).toEqual(['owner-id'])
  })

  test('does not overwrite an existing file when seeding', () => {
    fs.writeFileSync(
      path.join(tmpDir, ALLOWED_USERS_FILENAME),
      `${JSON.stringify({ userIds: ['already-allowed'] }, null, 2)}\n`,
    )
    seedGuildOwner('owner-id')
    expect(loadAllowedUserIds()).toEqual(['already-allowed'])
    expect(isAllowedUserId('owner-id')).toBe(false)
  })

  test('merges extra IDs from SHUVMAKI_ALLOWED_USER_IDS', () => {
    seedGuildOwner('owner-id')
    process.env[ALLOWED_USER_IDS_ENV] = 'env-one, env-two env-one'
    expect(loadAllowedUserIds()).toEqual(['owner-id', 'env-one', 'env-two'])
    expect(isAllowedUserId('env-two')).toBe(true)
  })
})
