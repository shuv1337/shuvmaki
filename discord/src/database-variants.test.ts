import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'

// Tests verify the SQL patterns used in database.ts variant helpers.
// Uses bun:sqlite (compatible API with better-sqlite3) for in-memory testing.
// This validates schema creation and CRUD operations without touching real database.

let testDb: Database

describe('variant preference helpers', () => {
  beforeEach(() => {
    // Create fresh in-memory database for each test
    testDb = new Database(':memory:')

    // Run the same migration SQL as runModelMigrations() in database.ts
    testDb.run(`
      CREATE TABLE IF NOT EXISTS channel_variants (
        channel_id TEXT PRIMARY KEY,
        variant_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    testDb.run(`
      CREATE TABLE IF NOT EXISTS session_variants (
        session_id TEXT PRIMARY KEY,
        variant_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
  })

  afterEach(() => {
    testDb.close()
  })

  describe('channel variants', () => {
    test('getChannelVariant returns undefined for non-existent channel', () => {
      const result = testDb
        .prepare(
          'SELECT variant_name FROM channel_variants WHERE channel_id = ?',
        )
        .get('non-existent') as { variant_name: string } | null
      expect(result).toBeNull()
    })

    test('set and get channel variant roundtrip', () => {
      const channelId = 'channel-123'
      const variantName = 'thinking-high'

      // Insert using same SQL pattern as setChannelVariant()
      testDb
        .prepare(
          `INSERT INTO channel_variants (channel_id, variant_name, updated_at) 
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(channel_id) DO UPDATE SET variant_name = excluded.variant_name, updated_at = CURRENT_TIMESTAMP`,
        )
        .run(channelId, variantName)

      // Get using same SQL pattern as getChannelVariant()
      const result = testDb
        .prepare(
          'SELECT variant_name FROM channel_variants WHERE channel_id = ?',
        )
        .get(channelId) as { variant_name: string } | null

      expect(result?.variant_name).toBe('thinking-high')
    })

    test('setChannelVariant updates existing variant', () => {
      const channelId = 'channel-456'

      // Set initial variant
      testDb
        .prepare(
          `INSERT INTO channel_variants (channel_id, variant_name, updated_at) 
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(channel_id) DO UPDATE SET variant_name = excluded.variant_name, updated_at = CURRENT_TIMESTAMP`,
        )
        .run(channelId, 'variant-1')

      // Update to new variant
      testDb
        .prepare(
          `INSERT INTO channel_variants (channel_id, variant_name, updated_at) 
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(channel_id) DO UPDATE SET variant_name = excluded.variant_name, updated_at = CURRENT_TIMESTAMP`,
        )
        .run(channelId, 'variant-2')

      const result = testDb
        .prepare(
          'SELECT variant_name FROM channel_variants WHERE channel_id = ?',
        )
        .get(channelId) as { variant_name: string } | null

      expect(result?.variant_name).toBe('variant-2')
    })

    test('clearChannelVariant removes variant', () => {
      const channelId = 'channel-789'

      // Set variant
      testDb
        .prepare(
          `INSERT INTO channel_variants (channel_id, variant_name, updated_at) 
           VALUES (?, ?, CURRENT_TIMESTAMP)`,
        )
        .run(channelId, 'to-be-cleared')

      // Clear variant using same SQL pattern as clearChannelVariant()
      testDb
        .prepare('DELETE FROM channel_variants WHERE channel_id = ?')
        .run(channelId)

      const result = testDb
        .prepare(
          'SELECT variant_name FROM channel_variants WHERE channel_id = ?',
        )
        .get(channelId) as { variant_name: string } | null

      expect(result).toBeNull()
    })

    test('clearChannelVariant is idempotent for non-existent channel', () => {
      // Should not throw
      const stmt = testDb.prepare(
        'DELETE FROM channel_variants WHERE channel_id = ?',
      )
      expect(() => {
        stmt.run('never-existed')
      }).not.toThrow()
    })
  })

  describe('session variants', () => {
    test('getSessionVariant returns undefined for non-existent session', () => {
      const result = testDb
        .prepare(
          'SELECT variant_name FROM session_variants WHERE session_id = ?',
        )
        .get('non-existent') as { variant_name: string } | null
      expect(result).toBeNull()
    })

    test('set and get session variant roundtrip', () => {
      const sessionId = 'session-abc'
      const variantName = 'thinking-low'

      // Insert using same SQL pattern as setSessionVariant()
      testDb
        .prepare(
          `INSERT OR REPLACE INTO session_variants (session_id, variant_name) VALUES (?, ?)`,
        )
        .run(sessionId, variantName)

      // Get using same SQL pattern as getSessionVariant()
      const result = testDb
        .prepare(
          'SELECT variant_name FROM session_variants WHERE session_id = ?',
        )
        .get(sessionId) as { variant_name: string } | null

      expect(result?.variant_name).toBe('thinking-low')
    })

    test('setSessionVariant replaces existing variant', () => {
      const sessionId = 'session-def'

      // Set initial variant
      testDb
        .prepare(
          `INSERT OR REPLACE INTO session_variants (session_id, variant_name) VALUES (?, ?)`,
        )
        .run(sessionId, 'old-variant')

      // Replace with new variant
      testDb
        .prepare(
          `INSERT OR REPLACE INTO session_variants (session_id, variant_name) VALUES (?, ?)`,
        )
        .run(sessionId, 'new-variant')

      const result = testDb
        .prepare(
          'SELECT variant_name FROM session_variants WHERE session_id = ?',
        )
        .get(sessionId) as { variant_name: string } | null

      expect(result?.variant_name).toBe('new-variant')
    })

    test('clearSessionVariant removes variant', () => {
      const sessionId = 'session-ghi'

      // Set variant
      testDb
        .prepare(
          `INSERT OR REPLACE INTO session_variants (session_id, variant_name) VALUES (?, ?)`,
        )
        .run(sessionId, 'to-be-deleted')

      // Clear variant using same SQL pattern as clearSessionVariant()
      testDb
        .prepare('DELETE FROM session_variants WHERE session_id = ?')
        .run(sessionId)

      const result = testDb
        .prepare(
          'SELECT variant_name FROM session_variants WHERE session_id = ?',
        )
        .get(sessionId) as { variant_name: string } | null

      expect(result).toBeNull()
    })

    test('clearSessionVariant is idempotent for non-existent session', () => {
      // Should not throw
      const stmt = testDb.prepare(
        'DELETE FROM session_variants WHERE session_id = ?',
      )
      expect(() => {
        stmt.run('never-existed')
      }).not.toThrow()
    })
  })

  describe('table schema', () => {
    test('channel_variants has expected columns', () => {
      const columns = testDb
        .prepare("PRAGMA table_info('channel_variants')")
        .all() as Array<{
        name: string
        type: string
        notnull: number
        pk: number
      }>

      const columnNames = columns.map((c) => c.name)
      expect(columnNames).toContain('channel_id')
      expect(columnNames).toContain('variant_name')
      expect(columnNames).toContain('created_at')
      expect(columnNames).toContain('updated_at')

      // channel_id is primary key
      const pkColumn = columns.find((c) => c.pk === 1)
      expect(pkColumn?.name).toBe('channel_id')
    })

    test('session_variants has expected columns', () => {
      const columns = testDb
        .prepare("PRAGMA table_info('session_variants')")
        .all() as Array<{
        name: string
        type: string
        notnull: number
        pk: number
      }>

      const columnNames = columns.map((c) => c.name)
      expect(columnNames).toContain('session_id')
      expect(columnNames).toContain('variant_name')
      expect(columnNames).toContain('created_at')

      // session_id is primary key
      const pkColumn = columns.find((c) => c.pk === 1)
      expect(pkColumn?.name).toBe('session_id')
    })

    test('migrations are idempotent (CREATE IF NOT EXISTS)', () => {
      // Run create statements multiple times - should not throw
      expect(() => {
        testDb.run(`
          CREATE TABLE IF NOT EXISTS channel_variants (
            channel_id TEXT PRIMARY KEY,
            variant_name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `)
        testDb.run(`
          CREATE TABLE IF NOT EXISTS session_variants (
            session_id TEXT PRIMARY KEY,
            variant_name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `)
      }).not.toThrow()

      // Tables should still exist and work
      const result = testDb
        .prepare('SELECT COUNT(*) as count FROM channel_variants')
        .get() as { count: number }
      expect(result.count).toBe(0)
    })
  })

  describe('variant preference resolution (session overrides channel)', () => {
    // These tests verify the resolution logic used in session-handler.ts:788-790
    // Pattern: getSessionVariant(session.id) || (channelId ? getChannelVariant(channelId) : undefined)

    const getSessionVariant = (sessionId: string): string | undefined => {
      const result = testDb
        .prepare(
          'SELECT variant_name FROM session_variants WHERE session_id = ?',
        )
        .get(sessionId) as { variant_name: string } | null
      return result?.variant_name
    }

    const getChannelVariant = (channelId: string): string | undefined => {
      const result = testDb
        .prepare(
          'SELECT variant_name FROM channel_variants WHERE channel_id = ?',
        )
        .get(channelId) as { variant_name: string } | null
      return result?.variant_name
    }

    const resolveVariant = (
      sessionId: string,
      channelId: string | undefined,
    ): string | undefined => {
      // Same logic as session-handler.ts:788-790
      return (
        getSessionVariant(sessionId) ||
        (channelId ? getChannelVariant(channelId) : undefined)
      )
    }

    test('session variant overrides channel variant', () => {
      const sessionId = 'session-override-test'
      const channelId = 'channel-override-test'

      // Set channel variant
      testDb
        .prepare(
          `INSERT INTO channel_variants (channel_id, variant_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        )
        .run(channelId, 'channel-thinking')

      // Set session variant (should override)
      testDb
        .prepare(
          `INSERT OR REPLACE INTO session_variants (session_id, variant_name) VALUES (?, ?)`,
        )
        .run(sessionId, 'session-thinking')

      const result = resolveVariant(sessionId, channelId)
      expect(result).toBe('session-thinking')
    })

    test('channel variant used when no session variant', () => {
      const sessionId = 'session-no-variant'
      const channelId = 'channel-has-variant'

      // Only set channel variant
      testDb
        .prepare(
          `INSERT INTO channel_variants (channel_id, variant_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        )
        .run(channelId, 'channel-fallback')

      // No session variant set

      const result = resolveVariant(sessionId, channelId)
      expect(result).toBe('channel-fallback')
    })

    test('returns undefined when no variants set', () => {
      const sessionId = 'session-nothing'
      const channelId = 'channel-nothing'

      // Neither session nor channel variant set

      const result = resolveVariant(sessionId, channelId)
      expect(result).toBeUndefined()
    })

    test('session variant used even when channelId is undefined', () => {
      const sessionId = 'session-with-variant'
      const channelId = undefined // e.g., DM context

      // Set session variant
      testDb
        .prepare(
          `INSERT OR REPLACE INTO session_variants (session_id, variant_name) VALUES (?, ?)`,
        )
        .run(sessionId, 'dm-variant')

      const result = resolveVariant(sessionId, channelId)
      expect(result).toBe('dm-variant')
    })

    test('returns undefined when only channel variant exists but channelId is undefined', () => {
      const sessionId = 'session-no-variant-dm'
      const channelId = undefined // DM context, no channel lookup possible

      // Only set channel variant (but channelId is undefined, so can't access)
      testDb
        .prepare(
          `INSERT INTO channel_variants (channel_id, variant_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        )
        .run('some-other-channel', 'unreachable-variant')

      const result = resolveVariant(sessionId, channelId)
      expect(result).toBeUndefined()
    })
  })
})
