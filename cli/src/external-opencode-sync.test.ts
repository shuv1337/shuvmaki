import { describe, expect, test } from 'vitest'
import { externalOpencodeSyncInternals } from './external-opencode-sync.js'
import { mapShuvcodeSessionMessages } from './shuvcode-sdk-url.js'

describe('external OpenCode sync deduplication', () => {
  test('maps identical history once and skips it on the next poll', () => {
    const messages = mapShuvcodeSessionMessages(
      [
        { id: 'msg_user', type: 'user', text: 'hello', time: { created: 1 } },
        {
          id: 'msg_assistant',
          type: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          time: { created: 2, completed: 3 },
        },
      ],
      { sessionID: 'ses_1' },
    ) as Parameters<
      typeof externalOpencodeSyncInternals.collectUnsyncedChunks
    >[0]['messages']
    const syncedPartIds = new Set<string>()
    const args = {
      messages,
      syncedPartIds,
      verbosity: 'text_only' as const,
      thread: { id: 'thread_1' },
    }

    const first = externalOpencodeSyncInternals.collectUnsyncedChunks(args)
    expect(first.chunks.map((chunk) => chunk.partIds)).toEqual([
      ['msg_user:part:0'],
      ['text-ses_1-msg_assistant-0'],
    ])
    for (const chunk of first.chunks) {
      for (const partId of chunk.partIds) syncedPartIds.add(partId)
    }

    expect(externalOpencodeSyncInternals.collectUnsyncedChunks(args).chunks).toEqual([])
  })

  test('rejects malformed parts without stable ids', () => {
    expect(externalOpencodeSyncInternals.hasStablePartId({})).toBe(false)
    expect(externalOpencodeSyncInternals.hasStablePartId({ id: '' })).toBe(false)
    expect(externalOpencodeSyncInternals.hasStablePartId({ id: 'part_1' })).toBe(true)
  })

  test('rejects sessions older than the local sync window', () => {
    expect(
      externalOpencodeSyncInternals.shouldSyncExternalSession({
        session: { title: 'Historical session', time: { created: 1, updated: 2 } },
        startMs: 3,
      }),
    ).toBe(false)
    expect(
      externalOpencodeSyncInternals.shouldSyncExternalSession({
        session: { title: 'Current session', time: { created: 1, updated: 3 } },
        startMs: 3,
      }),
    ).toBe(true)
  })

  test('does not start another directory after shutdown begins', async () => {
    const started: string[] = []
    let stopping = false

    await externalOpencodeSyncInternals.runDirectorySyncTargets({
      targets: ['first', 'second'],
      shouldStop: () => stopping,
      runTarget: async (target) => {
        started.push(target)
        stopping = true
      },
    })

    expect(started).toEqual(['first'])
  })
})
