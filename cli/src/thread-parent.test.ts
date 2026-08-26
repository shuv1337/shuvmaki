import { describe, expect, test, vi } from 'vitest'
import { resolveThreadParentId } from './thread-parent.js'

describe('resolveThreadParentId', () => {
  test('fetches a partial thread to recover its parent after restart', async () => {
    const fetch = vi.fn(async () => ({
      isThread: () => true,
      parentId: 'parent-channel',
    }))

    const parentId = await resolveThreadParentId({
      channelId: 'thread-channel',
      cachedParentId: null,
      client: { channels: { fetch } },
    } as never)

    expect(parentId).toBe('parent-channel')
    expect(fetch).toHaveBeenCalledWith('thread-channel', { force: true })
  })
})
