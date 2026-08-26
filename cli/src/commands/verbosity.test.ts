import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ChannelType, type ChatInputCommandInteraction } from 'discord.js'

const findFirst = vi.fn()

vi.mock('../db.js', () => ({
  closeDb: vi.fn(),
  getDb: vi.fn(async () => ({
    query: {
      channel_verbosity: { findFirst },
    },
  })),
}))

vi.mock('../store.js', () => ({
  store: {
    getState: () => ({ defaultVerbosity: 'text_and_essential_tools' }),
  },
}))

const { handleVerbosityCommand } = await import('./verbosity.js')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('/verbosity', () => {
  test('acknowledges the interaction before reading the channel setting', async () => {
    let resolveSetting: ((value: undefined) => void) | undefined
    findFirst.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSetting = resolve
      }),
    )

    const deferReply = vi.fn(async () => undefined)
    const editReply = vi.fn(async () => undefined)
    const command = {
      channel: { id: 'channel-1', type: ChannelType.GuildText },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction

    const handling = handleVerbosityCommand({ command, appId: 'app-1' })
    await vi.waitFor(() => expect(findFirst).toHaveBeenCalledOnce())

    expect(deferReply).toHaveBeenCalledOnce()
    expect(editReply).not.toHaveBeenCalled()

    resolveSetting?.(undefined)
    await handling

    expect(editReply).toHaveBeenCalledOnce()
  })
})
