// /variant command - Set the preferred variant for this channel or session.
// Variants are model-specific configurations (e.g., thinking modes, reasoning levels).

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
  getSessionModel,
  getChannelModel,
  setSessionVariant,
  setChannelVariant,
  clearSessionVariant,
  clearChannelVariant,
  runModelMigrations,
} from '../database.js'
import {
  initializeOpencodeForDirectory,
  getOpencodeClientV2,
} from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata } from '../discord-utils.js'
import { abortAndRetrySession } from '../session-handler.js'
import { createLogger } from '../logger.js'

const variantLogger = createLogger('VARIANT')

// TTL for pending variant selection contexts (5 minutes)
const PENDING_CONTEXT_TTL_MS = 5 * 60 * 1000

type VariantContext = {
  dir: string
  channelId: string
  sessionId?: string
  isThread: boolean
  thread?: ThreadChannel
  modelId: string
  createdAt: number
}

// Store pending variant selection contexts by hash
const pendingVariantContexts = new Map<string, VariantContext>()

/**
 * Clean up expired pending contexts.
 * Called before adding new contexts to prevent unbounded memory growth.
 */
function cleanupExpiredContexts(): void {
  const now = Date.now()
  for (const [hash, context] of pendingVariantContexts) {
    if (now - context.createdAt > PENDING_CONTEXT_TTL_MS) {
      pendingVariantContexts.delete(hash)
      variantLogger.log(`[VARIANT] Cleaned up expired context: ${hash}`)
    }
  }
}

/**
 * Build variant options from model metadata.
 * Filters disabled variants, sorts alphabetically, limits to 24, adds Default option.
 */
export function buildVariantOptions(variants: {
  [key: string]: { [key: string]: unknown }
}): Array<{ label: string; value: string; description: string }> {
  const entries = Object.entries(variants)
    .filter(([, v]) => {
      return !(v as { disabled?: boolean }).disabled
    })
    .sort(([a], [b]) => {
      return a.localeCompare(b)
    })
    .slice(0, 24)

  const options = entries.map(([key, value]) => {
    const description =
      (value as { description?: string }).description || 'Model variant'
    return {
      label: key.slice(0, 100),
      value: key,
      description: description.slice(0, 100),
    }
  })

  // Add Default option at the end
  options.push({
    label: 'Default',
    value: '__default__',
    description: 'Use model without a specific variant',
  })

  return options
}

/**
 * Handle the /variant slash command.
 * Shows available variants for the currently selected model.
 */
export async function handleVariantCommand({
  interaction,
  appId,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  variantLogger.log('[VARIANT] handleVariantCommand called')

  await interaction.deferReply({ ephemeral: true })
  variantLogger.log('[VARIANT] Deferred reply')

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

  // Get current model preference (session then channel fallback)
  const currentModel = sessionId
    ? getSessionModel(sessionId) || getChannelModel(targetChannelId)
    : getChannelModel(targetChannelId)

  if (!currentModel) {
    await interaction.editReply({
      content: 'No model preference set. Run `/model` first to select a model.',
    })
    return
  }

  // Parse provider and model from full model ID (format: provider_id/model_id)
  const [providerId, ...modelParts] = currentModel.split('/')
  const modelId = modelParts.join('/')
  if (!providerId || !modelId) {
    await interaction.editReply({
      content: `Invalid model format: ${currentModel}. Run \`/model\` to set a valid model.`,
    })
    return
  }

  try {
    await initializeOpencodeForDirectory(projectDirectory)
    const clientV2 = getOpencodeClientV2(projectDirectory)

    if (!clientV2) {
      await interaction.editReply({
        content: 'Failed to connect to OpenCode server',
      })
      return
    }

    const { data: providersData, error: providersError } =
      await clientV2.provider.list({
        directory: projectDirectory,
      })

    if (providersError || !providersData) {
      variantLogger.error(
        '[VARIANT] Failed to fetch providers:',
        providersError,
      )
      await interaction.editReply({
        content: 'Failed to fetch providers',
      })
      return
    }

    const provider = providersData.all.find((p) => {
      return p.id === providerId
    })
    if (!provider) {
      await interaction.editReply({
        content: `Provider "${providerId}" not found`,
      })
      return
    }

    const model = provider.models[modelId]
    if (!model) {
      await interaction.editReply({
        content: `Model "${modelId}" not found in provider "${provider.name}"`,
      })
      return
    }

    if (!model.variants || Object.keys(model.variants).length === 0) {
      await interaction.editReply({
        content: `No variants available for **${model.name}**.`,
      })
      return
    }

    const options = buildVariantOptions(model.variants)

    if (options.length === 1) {
      // Only Default option means all variants are disabled
      await interaction.editReply({
        content: `No enabled variants available for **${model.name}**.`,
      })
      return
    }

    // Clean up expired contexts before adding new one
    cleanupExpiredContexts()

    const context: VariantContext = {
      dir: projectDirectory,
      channelId: targetChannelId,
      sessionId,
      isThread,
      thread: isThread ? (channel as ThreadChannel) : undefined,
      modelId: currentModel,
      createdAt: Date.now(),
    }
    const contextHash = crypto.randomBytes(8).toString('hex')
    pendingVariantContexts.set(contextHash, context)

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`variant_select:${contextHash}`)
      .setPlaceholder('Select a variant')
      .addOptions(options)

    const actionRow =
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

    await interaction.editReply({
      content: `**Set Variant for ${model.name}**\nSelect a variant:`,
      components: [actionRow],
    })
  } catch (error) {
    variantLogger.error('Error loading variants:', error)
    await interaction.editReply({
      content: `Failed to load variants: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

/**
 * Handle the variant select menu interaction.
 * Stores the variant preference and optionally aborts/retries the current session.
 */
export async function handleVariantSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('variant_select:')) {
    return
  }

  await interaction.deferUpdate()

  const contextHash = customId.replace('variant_select:', '')
  const context = pendingVariantContexts.get(contextHash)

  // Check if context exists and is not expired
  if (!context || Date.now() - context.createdAt > PENDING_CONTEXT_TTL_MS) {
    if (context) {
      pendingVariantContexts.delete(contextHash)
    }
    await interaction.editReply({
      content: 'Selection expired. Please run /variant again.',
      components: [],
    })
    return
  }

  const selectedVariant = interaction.values[0]
  if (!selectedVariant) {
    await interaction.editReply({
      content: 'No variant selected',
      components: [],
    })
    return
  }

  try {
    const isDefault = selectedVariant === '__default__'

    if (context.isThread && context.sessionId) {
      // Session-level preference
      if (isDefault) {
        clearSessionVariant(context.sessionId)
        variantLogger.log(`Cleared variant for session ${context.sessionId}`)
      } else {
        setSessionVariant(context.sessionId, selectedVariant)
        variantLogger.log(
          `Set variant ${selectedVariant} for session ${context.sessionId}`,
        )
      }

      // Abort and retry if there's an active request
      let retried = false
      if (context.thread) {
        retried = await abortAndRetrySession({
          sessionId: context.sessionId,
          thread: context.thread,
          projectDirectory: context.dir,
        })
      }

      const variantDisplay = isDefault ? 'Default' : `**${selectedVariant}**`
      if (retried) {
        await interaction.editReply({
          content: `Variant changed for this session: ${variantDisplay}\n\n_Retrying current request with new variant..._`,
          components: [],
        })
      } else {
        await interaction.editReply({
          content: `Variant preference set for this session: ${variantDisplay}`,
          components: [],
        })
      }
    } else {
      // Channel-level preference
      if (isDefault) {
        clearChannelVariant(context.channelId)
        variantLogger.log(`Cleared variant for channel ${context.channelId}`)
      } else {
        setChannelVariant(context.channelId, selectedVariant)
        variantLogger.log(
          `Set variant ${selectedVariant} for channel ${context.channelId}`,
        )
      }

      const variantDisplay = isDefault ? 'Default' : `**${selectedVariant}**`
      await interaction.editReply({
        content: `Variant preference set for this channel: ${variantDisplay}\n\nAll new sessions in this channel will use this variant.`,
        components: [],
      })
    }

    pendingVariantContexts.delete(contextHash)
  } catch (error) {
    variantLogger.error('Error saving variant preference:', error)
    await interaction.editReply({
      content: `Failed to save variant preference: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}
