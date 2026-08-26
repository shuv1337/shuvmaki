import { PermissionsBitField, type Message } from 'discord.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  ALLOWED_USER_IDS_ENV,
  ALLOWED_USERS_FILENAME,
} from './allowed-users.js'
import { getDataDir, setDataDir } from './config.js'
import {
  hasKimakiAdminPermission,
  hasKimakiBotPermission,
  resolveGuildMessageMember,
  splitMarkdownForDiscord,
} from './discord-utils.js'
import { store } from './store.js'

describe('splitMarkdownForDiscord', () => {
  test('never returns chunks over the max length with code fences', () => {
    const maxLength = 2000
    const header = '## Summary of Current Architecture\n\n'
    const codeFenceStart = '```\n'
    const codeFenceEnd = '\n```\n'
    const codeLine = 'x'.repeat(180)
    const codeBlock = Array.from({ length: 20 })
      .map(() => codeLine)
      .join('\n')
    const markdown = `${header}${codeFenceStart}${codeBlock}${codeFenceEnd}`

    const chunks = splitMarkdownForDiscord({ content: markdown, maxLength })

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLength)
    }
  })

  // Without the lineLength fix for opening fences on non-empty chunks, the opening
  // fence text "```\n" gets appended without being counted in the overflow check.
  // When the chunk is later flushed with a closing fence, it exceeds maxLength.
  test('opening fence on non-empty chunk is counted in overflow check', () => {
    const maxLength = 60
    // 55 chars of text + paragraph break, then a code block.
    // The text fills the chunk to ~57 chars. The opening fence "```\n" (4 chars)
    // would push to 61 if not counted, then flushing adds "```\n" (4 more) = 65.
    const markdown = 'a'.repeat(55) + '\n\n```\nshort code\n```\n'

    const chunks = splitMarkdownForDiscord({ content: markdown, maxLength })

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLength)
    }
  })

  test('list item code block keeps newline before fence when splitting', () => {
    const content = `- File: playwriter/src/aria-snapshot.ts
- Add helper function (~line 477, after isTextRole):
  \`\`\`ts
  function isSubstringOfAny(needle: string, haystack: Set<string>): boolean {
    for (const str of haystack) {
      if (str.includes(needle)) {
        return true
      }
    }
    return false
  }
  \`\`\`
`

    const result = splitMarkdownForDiscord({ content, maxLength: 80 })
    expect(result).toMatchInlineSnapshot(`
      [
        "- File: playwriter/src/aria-snapshot.ts
      ",
        "- Add helper function (~line 477, after isTextRole):
        \`\`\`ts
      ",
        "  function isSubstringOfAny(needle: string, haystack: Set<string>): boolean {
      ",
        "    for (const str of haystack) {
            if (str.includes(needle)) {
      ",
        "        return true
            }
          }
          return false
        }
        \`\`\`
      ",
      ]
    `)
  })

  test('task list code block does not duplicate checkbox marker when splitting', () => {
    const content = `- [ ] Do thing
  \`\`\`sh
  echo hi
  \`\`\`
`

    const result = splitMarkdownForDiscord({ content, maxLength: 80 })
    expect(result.join('')).toContain('- [ ] Do thing\n')
    expect(result.join('')).not.toContain('- [ ] [ ] Do thing')
    expect(result).toMatchInlineSnapshot(`
      [
        "- [ ] Do thing
        \`\`\`sh
        echo hi
        \`\`\`
      ",
      ]
    `)
  })
})

function writeAllowedUsers(userIds: string[]): void {
  fs.writeFileSync(
    path.join(getDataDir(), ALLOWED_USERS_FILENAME),
    `${JSON.stringify({ userIds }, null, 2)}\n`,
  )
}

describe('hasKimakiBotPermission', () => {
  let tmpDir = ''
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env[ALLOWED_USER_IDS_ENV]
    delete process.env[ALLOWED_USER_IDS_ENV]
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-permission-'))
    setDataDir(tmpDir)
    store.setState({ allowAllUsers: false })
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ALLOWED_USER_IDS_ENV]
    } else {
      process.env[ALLOWED_USER_IDS_ENV] = originalEnv
    }
    store.setState({ allowAllUsers: false })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('denies allowAllUsers member who is not on the allowlist', () => {
    store.setState({ allowAllUsers: true })
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(false)
  })

  test('allows allowAllUsers member who is on the allowlist', () => {
    store.setState({ allowAllUsers: true })
    writeAllowedUsers(['member-id'])
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(true)
  })

  test('still blocks no-kimaki role even when allowAllUsers and allowlist are enabled', () => {
    store.setState({ allowAllUsers: true })
    writeAllowedUsers(['member-id'])
    const noKimakiRoleId = '222'
    const guild = {
      ownerId: 'owner-id',
      roles: {
        cache: new Map([
          [noKimakiRoleId, { id: noKimakiRoleId, name: 'no-kimaki' }],
        ]),
      },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [noKimakiRoleId],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(false)
  })

  test('still blocks no-shuvmaki role even when allowlisted', () => {
    writeAllowedUsers(['member-id'])
    const noShuvmakiRoleId = '223'
    const guild = {
      ownerId: 'owner-id',
      roles: {
        cache: new Map([
          [noShuvmakiRoleId, { id: noShuvmakiRoleId, name: 'no-shuvmaki' }],
        ]),
      },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: PermissionsBitField.Flags.Administrator.toString(),
      roles: [noShuvmakiRoleId],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(false)
  })

  test('denies shuvmaki role when user is not on the allowlist', () => {
    const shuvmakiRoleId = '333'
    const guild = {
      ownerId: 'owner-id',
      roles: {
        cache: new Map([
          [shuvmakiRoleId, { id: shuvmakiRoleId, name: 'shuvmaki' }],
        ]),
      },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [shuvmakiRoleId],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(false)
  })

  test('allows API interaction member when shuvmaki role and allowlist match', () => {
    writeAllowedUsers(['member-id'])
    const shuvmakiRoleId = '333'
    const guild = {
      ownerId: 'owner-id',
      roles: {
        cache: new Map([
          [shuvmakiRoleId, { id: shuvmakiRoleId, name: 'shuvmaki' }],
        ]),
      },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [shuvmakiRoleId],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(true)
  })

  test('allows API interaction member when kimaki role and allowlist match', () => {
    writeAllowedUsers(['member-id'])
    const kimakiRoleId = '111'
    const guild = {
      ownerId: 'owner-id',
      roles: {
        cache: new Map([
          [kimakiRoleId, { id: kimakiRoleId, name: 'Kimaki' }],
        ]),
      },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [kimakiRoleId],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(true)
  })

  test('allows API interaction member with ManageGuild permission when allowlisted', () => {
    writeAllowedUsers(['member-id'])
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: PermissionsBitField.Flags.ManageGuild.toString(),
      roles: [],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(true)
  })

  test('denies API interaction member with no role, owner, or admin rights', () => {
    writeAllowedUsers(['member-id'])
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(false)
  })

  test('seeds guild owner into allowed-users.json and allows the owner', () => {
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'owner-id' },
      permissions: '0',
      roles: [],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(true)
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, ALLOWED_USERS_FILENAME), 'utf8')),
    ).toEqual({ userIds: ['owner-id'] })
  })

  test('allows env extra IDs from SHUVMAKI_ALLOWED_USER_IDS with a role', () => {
    process.env[ALLOWED_USER_IDS_ENV] = 'env-user'
    const shuvmakiRoleId = '333'
    const guild = {
      ownerId: 'owner-id',
      roles: {
        cache: new Map([
          [shuvmakiRoleId, { id: shuvmakiRoleId, name: 'shuvmaki' }],
        ]),
      },
    } as any

    const member = {
      user: { id: 'env-user' },
      permissions: '0',
      roles: [shuvmakiRoleId],
    } as any

    expect(hasKimakiBotPermission(member, guild)).toBe(true)
  })
})

describe('hasKimakiAdminPermission', () => {
  let tmpDir = ''
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env[ALLOWED_USER_IDS_ENV]
    delete process.env[ALLOWED_USER_IDS_ENV]
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-admin-permission-'))
    setDataDir(tmpDir)
    store.setState({ allowAllUsers: false })
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ALLOWED_USER_IDS_ENV]
    } else {
      process.env[ALLOWED_USER_IDS_ENV] = originalEnv
    }
    store.setState({ allowAllUsers: false })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('denies unprivileged member even when allowAllUsers is enabled', () => {
    store.setState({ allowAllUsers: true })
    writeAllowedUsers(['member-id'])
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: '0',
      roles: [],
    } as any

    expect(hasKimakiAdminPermission(member, guild)).toBe(false)
  })

  test('denies admin who is not on the allowlist', () => {
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: PermissionsBitField.Flags.Administrator.toString(),
      roles: [],
    } as any

    expect(hasKimakiAdminPermission(member, guild)).toBe(false)
  })

  test('allows admin even when allowAllUsers is enabled if allowlisted', () => {
    store.setState({ allowAllUsers: true })
    writeAllowedUsers(['member-id'])
    const guild = {
      ownerId: 'owner-id',
      roles: { cache: new Map() },
    } as any

    const member = {
      user: { id: 'member-id' },
      permissions: PermissionsBitField.Flags.Administrator.toString(),
      roles: [],
    } as any

    expect(hasKimakiAdminPermission(member, guild)).toBe(true)
  })
})

describe('resolveGuildMessageMember', () => {
  test('uses hydrated message member without fetching', async () => {
    const member = { id: 'member-id' }
    const message = {
      guild: {
        members: {
          fetch() {
            throw new Error('should not fetch')
          },
        },
      },
      member,
      author: { id: 'member-id' },
      id: 'message-id',
    } as unknown as Message

    await expect(resolveGuildMessageMember(message)).resolves.toBe(member)
  })

  test('fetches missing guild message member', async () => {
    const member = { id: 'member-id' }
    const message = {
      guild: {
        members: {
          fetch(id: string) {
            expect(id).toBe('member-id')
            return Promise.resolve(member)
          },
        },
      },
      member: null,
      author: { id: 'member-id' },
      id: 'message-id',
    } as unknown as Message

    await expect(resolveGuildMessageMember(message)).resolves.toBe(member)
  })

  test('denies when missing guild message member cannot be fetched', async () => {
    const message = {
      guild: {
        members: {
          fetch() {
            return Promise.reject(new Error('missing member'))
          },
        },
      },
      member: null,
      author: { id: 'member-id' },
      id: 'message-id',
    } as unknown as Message

    await expect(resolveGuildMessageMember(message)).resolves.toBe(null)
  })
})
