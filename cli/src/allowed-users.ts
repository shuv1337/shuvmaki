// Durable Discord user-id allowlist stored in the data dir.
// Unapproved users must not get bot replies; role/admin/owner is not enough.

import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'
import { createLogger, LogPrefix } from './logger.js'

const allowedUsersLogger = createLogger(LogPrefix.PERMISSIONS)

export const ALLOWED_USERS_FILENAME = 'allowed-users.json'
export const ALLOWED_USER_IDS_ENV = 'SHUVMAKI_ALLOWED_USER_IDS'

export function allowedUsersFilePath(): string {
  return path.join(getDataDir(), ALLOWED_USERS_FILENAME)
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    result.push(id)
  }
  return result
}

function envAllowedUserIds(): string[] {
  const raw = process.env[ALLOWED_USER_IDS_ENV]
  if (!raw) {
    return []
  }
  return raw.split(/[\s,]+/).filter((id) => id.length > 0)
}

function parseFileUserIds(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('userIds' in value)) {
    return []
  }
  const { userIds } = value
  if (!Array.isArray(userIds)) {
    return []
  }
  return userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

function readAllowedUsersFile(): { exists: boolean; userIds: string[] } {
  const filePath = allowedUsersFilePath()
  if (!fs.existsSync(filePath)) {
    return { exists: false, userIds: [] }
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return { exists: true, userIds: parseFileUserIds(parsed) }
  } catch {
    allowedUsersLogger.warn('Failed to read allowed-users.json')
    return { exists: true, userIds: [] }
  }
}

function writeAllowedUsersFile(userIds: string[]): void {
  const dir = getDataDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(
    allowedUsersFilePath(),
    `${JSON.stringify({ userIds }, null, 2)}\n`,
  )
}

export function loadAllowedUserIds(): string[] {
  const fileIds = readAllowedUsersFile().userIds
  return uniqueIds([...fileIds, ...envAllowedUserIds()])
}

export function seedGuildOwner(ownerId: string): void {
  if (!ownerId) {
    return
  }
  const current = readAllowedUsersFile()
  if (current.exists) {
    return
  }
  writeAllowedUsersFile([ownerId])
  allowedUsersLogger.log(`Seeded guild owner ${ownerId} into allowed-users.json`)
}

export function isAllowedUserId(userId: string): boolean {
  if (!userId) {
    return false
  }
  return loadAllowedUserIds().includes(userId)
}
