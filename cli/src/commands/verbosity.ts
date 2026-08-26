// /verbosity command.
// Shows a dropdown to set output verbosity level for sessions in a channel.
// 'text_and_essential_tools': shows text and essential tools (edits, custom MCP tools)
// 'tools_and_text': shows all output including tool executions
// 'text_only' (default): only shows text responses; typing still indicates active work

import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ChannelType,
  type ThreadChannel,
} from 'discord.js'
import { getChannelVerbosity, setChannelVerbosity, type VerbosityLevel } from '../database.js'
import { getDb } from '../db.js'
import { store } from '../store.js'
import { createLogger, LogPrefix } from '../logger.js'

const verbosityLogger = createLogger(LogPrefix.VERBOSITY)

const VERBOSITY_OPTIONS: Array<{
  value: VerbosityLevel
  label: string
  description: string
}> = [
  {
    value: 'tools_and_text',
    label: 'Tools and text',
    description: 'All output including tool executions and status messages',
  },
  {
    value: 'text_and_essential_tools',
    label: 'Text and essential tools',
    description: 'Text + essential tools (edits, custom MCP). Hides read/search.',
  },
  {
    value: 'text_only',
    label: 'Text only',
    description: 'Text responses only. Typing still shows when work is active.',
  },
]

function resolveChannelId(channel: ChatInputCommandInteraction['channel']): string | null {
  if (!channel) {
    return null
  }
  if (channel.type === ChannelType.GuildText) {
    return channel.id
  }
  if (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  ) {
    return (channel as ThreadChannel).parentId || channel.id
  }
  return channel.id
}

/**
 * Check if there is a per-channel verbosity override in the DB.
 * Returns the override value if it exists, null otherwise.
 */
async function getChannelVerbosityOverride(channelId: string): Promise<VerbosityLevel | null> {
  const db = await getDb()
  const row = await db.query.channel_verbosity.findFirst({
    where: { channel_id: channelId },
  })
  if (row?.verbosity) {
    return row.verbosity
  }
  return null
}

/**
 * Handle the /verbosity slash command.
 * Shows a dropdown with the current verbosity level and available options.
 */
export async function handleVerbosityCommand({
  command,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  verbosityLogger.log('[VERBOSITY] Command called')

  // Acknowledge before reading SQLite so lock contention cannot expire the
  // interaction's three-second response window.
  await command.deferReply()

  const channelId = resolveChannelId(command.channel)
  if (!channelId) {
    await command.editReply({
      content: 'Could not determine channel.',
    })
    return
  }

  const override = await getChannelVerbosityOverride(channelId)
  const currentLevel = override || store.getState().defaultVerbosity
  const source = override ? 'channel override' : 'global default'

  const options = VERBOSITY_OPTIONS.map((opt) => ({
    label: opt.label,
    value: opt.value,
    description: opt.description,
    default: opt.value === currentLevel,
  }))

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`verbosity_select:${channelId}`)
    .setPlaceholder('Select verbosity level')
    .addOptions(options)

  const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

  await command.editReply({
    content: `**Verbosity**\nCurrent: \`${currentLevel}\` (${source})`,
    components: [actionRow],
  })
}

/**
 * Handle the verbosity select menu interaction.
 * Sets the selected verbosity level for the channel.
 */
export async function handleVerbositySelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('verbosity_select:')) {
    return
  }

  await interaction.deferUpdate()

  const channelId = customId.replace('verbosity_select:', '')
  const level = interaction.values[0] as VerbosityLevel | undefined

  if (!level) {
    await interaction.editReply({
      content: 'No level selected.',
      components: [],
    })
    return
  }

  const currentLevel = await getChannelVerbosity(channelId)
  if (currentLevel === level) {
    await interaction.editReply({
      content: `Verbosity is already \`${level}\` for this channel.`,
      components: [],
    })
    return
  }

  await setChannelVerbosity(channelId, level)
  verbosityLogger.log(`[VERBOSITY] Set channel ${channelId} to ${level}`)

  const description = VERBOSITY_OPTIONS.find((o) => o.value === level)?.description || ''

  await interaction.editReply({
    content: `Verbosity set to \`${level}\` for this channel.\n${description}\nApplies immediately, including active sessions.`,
    components: [],
  })
}
