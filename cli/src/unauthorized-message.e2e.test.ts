import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { setDataDir } from './config.js'
import {
  closeDatabase,
  initDatabase,
  setBotToken,
  setChannelDirectory,
} from './database.js'
import { startDiscordBot } from './discord-bot.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { chooseLockPort } from './test-utils.js'

const USER_ID = '200000000000009001'
const OWNER_ID = '200000000000009002'
const CHANNEL_ID = '200000000000009003'
const BOT_ID = '200000000000009004'

describe('unauthorized messages', () => {
  let discord: DigitalDiscord
  let botClient: Client
  let dataDir: string

  beforeAll(async () => {
    const tmpRoot = path.join(process.cwd(), 'tmp')
    fs.mkdirSync(tmpRoot, { recursive: true })
    dataDir = fs.mkdtempSync(path.join(tmpRoot, 'unauthorized-message-'))
    process.env['KIMAKI_LOCK_PORT'] = String(
      chooseLockPort({ key: 'unauthorized-message-e2e' }),
    )
    setDataDir(dataDir)

    discord = new DigitalDiscord({
      botUser: { id: BOT_ID, username: 'TestBot' },
      guild: { ownerId: OWNER_ID },
      channels: [
        { id: CHANNEL_ID, name: 'unauthorized-message', type: ChannelType.GuildText },
      ],
      users: [{ id: USER_ID, username: 'unapproved-user' }],
      dbUrl: `file:${path.join(dataDir, 'digital-discord.db')}`,
    })
    await discord.start()
    await discord.prisma.guildMember.update({
      where: { guildId_userId: { guildId: discord.guildId, userId: USER_ID } },
      data: { permissions: '0' },
    })

    const hranaResult = await startHranaServer({
      dbPath: path.join(dataDir, 'discord-sessions.db'),
    })
    if (hranaResult instanceof Error) throw hranaResult
    process.env['KIMAKI_DB_URL'] = hranaResult
    await initDatabase()
    await setBotToken(discord.botUserId, discord.botToken)
    await setChannelDirectory({
      channelId: CHANNEL_ID,
      directory: dataDir,
      channelType: 'text',
    })
    botClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User],
      rest: { api: discord.restUrl, version: '10' },
    })
    await startDiscordBot({
      token: discord.botToken,
      appId: discord.botUserId,
      discordClient: botClient,
    })
  }, 20_000)

  afterAll(async () => {
    if (botClient) void botClient.destroy()
    await Promise.all([
      closeDatabase().catch(() => undefined),
      stopHranaServer().catch(() => undefined),
      discord?.stop().catch(() => undefined),
    ])
    delete process.env['KIMAKI_DB_URL']
    delete process.env['KIMAKI_LOCK_PORT']
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
  })

  test('silently ignores an @mention from an unapproved member', async () => {
    await discord.channel(CHANNEL_ID).user(USER_ID).sendMessage({
      content: `<@${BOT_ID}> make something expensive`,
    })

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      const messages = await discord.channel(CHANNEL_ID).getMessages()
      if (messages.length > 1) break
    }

    expect(await discord.channel(CHANNEL_ID).text()).toMatchInlineSnapshot(`
      "--- from: user (unapproved-user)
      <@200000000000009004> make something expensive"
    `)
    expect(await discord.channel(CHANNEL_ID).getThreads()).toHaveLength(0)
  })
})
