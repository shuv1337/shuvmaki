// /agent command - Set the preferred agent for this channel or session.

import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ChannelType,
  type ThreadChannel,
  type TextChannel,
} from 'discord.js'
import crypto from 'node:crypto'
import {
  getDatabase,
  setChannelAgent,
  setSessionAgent,
  runModelMigrations,
} from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata } from '../discord-utils.js'
import { createLogger } from '../logger.js'

const agentLogger = createLogger('AGENT')

// TTL for pending agent selection contexts (5 minutes)
const PENDING_CONTEXT_TTL_MS = 5 * 60 * 1000

type AgentContext = {
  dir: string
  channelId: string
  sessionId?: string
  isThread: boolean
  createdAt: number
}

const pendingAgentContexts = new Map<string, AgentContext>()

/**
 * Clean up expired pending contexts.
 * Called before adding new contexts to prevent unbounded memory growth.
 */
function cleanupExpiredContexts(): void {
  const now = Date.now()
  for (const [hash, context] of pendingAgentContexts) {
    if (now - context.createdAt > PENDING_CONTEXT_TTL_MS) {
      pendingAgentContexts.delete(hash)
      agentLogger.log(`[AGENT] Cleaned up expired context: ${hash}`)
    }
  }
}

export async function handleAgentCommand({
  interaction,
  appId,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  runModelMigrations()

  const channel = interaction.channel

  if (!channel) {
    await interaction.editReply({
      content: 'This command can only be used in a channel',
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  let projectDirectory: string | undefined
  let channelAppId: string | undefined
  let targetChannelId: string
  let sessionId: string | undefined

  if (isThread) {
    const thread = channel as ThreadChannel
    const textChannel = await resolveTextChannel(thread)
    const metadata = getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    channelAppId = metadata.channelAppId
    targetChannelId = textChannel?.id || channel.id

    const row = getDatabase()
      .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
      .get(thread.id) as { session_id: string } | undefined
    sessionId = row?.session_id
  } else if (channel.type === ChannelType.GuildText) {
    const textChannel = channel as TextChannel
    const metadata = getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    channelAppId = metadata.channelAppId
    targetChannelId = channel.id
  } else {
    await interaction.editReply({
      content: 'This command can only be used in text channels or threads',
    })
    return
  }

  if (channelAppId && channelAppId !== appId) {
    await interaction.editReply({
      content: 'This channel is not configured for this bot',
    })
    return
  }

  if (!projectDirectory) {
    await interaction.editReply({
      content: 'This channel is not configured with a project directory',
    })
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)

    const agentsResponse = await getClient().app.agents({
      query: { directory: projectDirectory },
    })

    if (!agentsResponse.data || agentsResponse.data.length === 0) {
      await interaction.editReply({ content: 'No agents available' })
      return
    }

    const agents = agentsResponse.data
      .filter((a) => a.mode === 'primary' || a.mode === 'all')
      .slice(0, 25)

    if (agents.length === 0) {
      await interaction.editReply({ content: 'No primary agents available' })
      return
    }

    // Clean up expired contexts before adding new one
    cleanupExpiredContexts()

    const contextHash = crypto.randomBytes(8).toString('hex')
    const context: AgentContext = {
      dir: projectDirectory,
      channelId: targetChannelId,
      sessionId,
      isThread,
      createdAt: Date.now(),
    }
    pendingAgentContexts.set(contextHash, context)

    const options = agents.map((agent) => ({
      label: agent.name.slice(0, 100),
      value: agent.name,
      description: (agent.description || `${agent.mode} agent`).slice(0, 100),
    }))

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`agent_select:${contextHash}`)
      .setPlaceholder('Select an agent')
      .addOptions(options)

    const actionRow =
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

    await interaction.editReply({
      content: '**Set Agent Preference**\nSelect an agent:',
      components: [actionRow],
    })
  } catch (error) {
    agentLogger.error('Error loading agents:', error)
    await interaction.editReply({
      content: `Failed to load agents: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

export async function handleAgentSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('agent_select:')) {
    return
  }

  await interaction.deferUpdate()

  const contextHash = customId.replace('agent_select:', '')
  const context = pendingAgentContexts.get(contextHash)

  // Check if context exists and is not expired
  if (!context || Date.now() - context.createdAt > PENDING_CONTEXT_TTL_MS) {
    if (context) {
      pendingAgentContexts.delete(contextHash)
    }
    await interaction.editReply({
      content: 'Selection expired. Please run /agent again.',
      components: [],
    })
    return
  }

  const selectedAgent = interaction.values[0]
  if (!selectedAgent) {
    await interaction.editReply({
      content: 'No agent selected',
      components: [],
    })
    return
  }

  try {
    if (context.isThread && context.sessionId) {
      setSessionAgent(context.sessionId, selectedAgent)
      agentLogger.log(
        `Set agent ${selectedAgent} for session ${context.sessionId}`,
      )

      await interaction.editReply({
        content: `Agent preference set for this session: **${selectedAgent}**`,
        components: [],
      })
    } else {
      setChannelAgent(context.channelId, selectedAgent)
      agentLogger.log(
        `Set agent ${selectedAgent} for channel ${context.channelId}`,
      )

      await interaction.editReply({
        content: `Agent preference set for this channel: **${selectedAgent}**\n\nAll new sessions in this channel will use this agent.`,
        components: [],
      })
    }

    pendingAgentContexts.delete(contextHash)
  } catch (error) {
    agentLogger.error('Error saving agent preference:', error)
    await interaction.editReply({
      content: `Failed to save agent preference: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}
