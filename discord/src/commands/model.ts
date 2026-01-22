// /model command - Set the preferred model for this channel or session.

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
  setChannelModel,
  setSessionModel,
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
import * as errore from 'errore'

const modelLogger = createLogger('MODEL')

// TTL for pending selection contexts (5 minutes)
const PENDING_CONTEXT_TTL_MS = 5 * 60 * 1000

type ModelContext = {
  dir: string
  channelId: string
  sessionId?: string
  isThread: boolean
  providerId?: string
  providerName?: string
  thread?: ThreadChannel
  createdAt: number
}

type ModelVariantContext = {
  dir: string
  channelId: string
  sessionId?: string
  isThread: boolean
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  thread?: ThreadChannel
  createdAt: number
}

// Store context by hash to avoid customId length limits (Discord max: 100 chars)
const pendingModelContexts = new Map<string, ModelContext>()

// Store context for model variant selection (shown after model is selected if variants exist)
const pendingModelVariantContexts = new Map<string, ModelVariantContext>()

/**
 * Clean up expired pending contexts from both Maps.
 * Called before adding new contexts to prevent unbounded memory growth.
 */
function cleanupExpiredContexts(): void {
  const now = Date.now()
  for (const [hash, context] of pendingModelContexts) {
    if (now - context.createdAt > PENDING_CONTEXT_TTL_MS) {
      pendingModelContexts.delete(hash)
      modelLogger.log(`[MODEL] Cleaned up expired model context: ${hash}`)
    }
  }
  for (const [hash, context] of pendingModelVariantContexts) {
    if (now - context.createdAt > PENDING_CONTEXT_TTL_MS) {
      pendingModelVariantContexts.delete(hash)
      modelLogger.log(`[MODEL] Cleaned up expired variant context: ${hash}`)
    }
  }
}

export type ProviderInfo = {
  id: string
  name: string
  models: Record<
    string,
    {
      id: string
      name: string
      release_date: string
    }
  >
}

/**
 * Build variant options from model metadata.
 * Filters disabled variants, sorts alphabetically, limits to 24, adds Default option.
 */
function buildVariantOptions(variants: {
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
 * Handle the /model slash command.
 * Shows a select menu with available providers.
 */
export async function handleModelCommand({
  interaction,
  appId,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  modelLogger.log('[MODEL] handleModelCommand called')

  // Defer reply immediately to avoid 3-second timeout
  await interaction.deferReply({ ephemeral: true })
  modelLogger.log('[MODEL] Deferred reply')

  // Ensure migrations are run
  runModelMigrations()

  const channel = interaction.channel

  if (!channel) {
    await interaction.editReply({
      content: 'This command can only be used in a channel',
    })
    return
  }

  // Determine if we're in a thread or text channel
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

    // Get session ID for this thread
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
    if (errore.isError(getClient)) {
      await interaction.editReply({ content: getClient.message })
      return
    }
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
      modelLogger.error('[MODEL] Failed to fetch providers:', providersError)
      await interaction.editReply({
        content: 'Failed to fetch providers',
      })
      return
    }

    const { all: allProviders, connected } = providersData

    // Filter to only connected providers (have credentials)
    const availableProviders = allProviders.filter((p) => {
      return connected.includes(p.id)
    })

    if (availableProviders.length === 0) {
      await interaction.editReply({
        content:
          'No providers with credentials found. Use `/connect` in OpenCode TUI to add provider credentials.',
      })
      return
    }

    // Clean up expired contexts before adding new one
    cleanupExpiredContexts()

    // Store context with a short hash key to avoid customId length limits
    const context: ModelContext = {
      dir: projectDirectory,
      channelId: targetChannelId,
      sessionId: sessionId,
      isThread: isThread,
      thread: isThread ? (channel as ThreadChannel) : undefined,
      createdAt: Date.now(),
    }
    const contextHash = crypto.randomBytes(8).toString('hex')
    pendingModelContexts.set(contextHash, context)

    const options = availableProviders.slice(0, 25).map((provider) => {
      const modelCount = Object.keys(provider.models || {}).length
      return {
        label: provider.name.slice(0, 100),
        value: provider.id,
        description:
          `${modelCount} model${modelCount !== 1 ? 's' : ''} available`.slice(
            0,
            100,
          ),
      }
    })

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`model_provider:${contextHash}`)
      .setPlaceholder('Select a provider')
      .addOptions(options)

    const actionRow =
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

    await interaction.editReply({
      content: '**Set Model Preference**\nSelect a provider:',
      components: [actionRow],
    })
  } catch (error) {
    modelLogger.error('Error loading providers:', error)
    await interaction.editReply({
      content: `Failed to load providers: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

/**
 * Handle the provider select menu interaction.
 * Shows a second select menu with models for the chosen provider.
 */
export async function handleProviderSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('model_provider:')) {
    return
  }

  // Defer update immediately to avoid timeout
  await interaction.deferUpdate()

  const contextHash = customId.replace('model_provider:', '')
  const context = pendingModelContexts.get(contextHash)

  // Check if context exists and is not expired
  if (!context || Date.now() - context.createdAt > PENDING_CONTEXT_TTL_MS) {
    if (context) {
      pendingModelContexts.delete(contextHash)
    }
    await interaction.editReply({
      content: 'Selection expired. Please run /model again.',
      components: [],
    })
    return
  }

  const selectedProviderId = interaction.values[0]
  if (!selectedProviderId) {
    await interaction.editReply({
      content: 'No provider selected',
      components: [],
    })
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(context.dir)
    if (errore.isError(getClient)) {
      await interaction.editReply({
        content: getClient.message,
        components: [],
      })
      return
    }
    const clientV2 = getOpencodeClientV2(context.dir)

    if (!clientV2) {
      await interaction.editReply({
        content: 'Failed to connect to OpenCode server',
        components: [],
      })
      return
    }

    const { data: providersData, error: providersError } =
      await clientV2.provider.list({
        directory: context.dir,
      })

    if (providersError || !providersData) {
      modelLogger.error('[MODEL] Failed to fetch providers:', providersError)
      await interaction.editReply({
        content: 'Failed to fetch providers',
        components: [],
      })
      return
    }

    const provider = providersData.all.find((p) => p.id === selectedProviderId)

    if (!provider) {
      await interaction.editReply({
        content: 'Provider not found',
        components: [],
      })
      return
    }

    const models = Object.entries(provider.models || {})
      .map(([modelId, model]) => ({
        id: modelId,
        name: model.name,
        releaseDate: model.release_date,
      }))
      // Sort by release date descending (most recent first)
      .sort((a, b) => {
        const dateA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0
        const dateB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0
        return dateB - dateA
      })

    if (models.length === 0) {
      await interaction.editReply({
        content: `No models available for ${provider.name}`,
        components: [],
      })
      return
    }

    // Take first 25 models (most recent since sorted descending)
    const recentModels = models.slice(0, 25)

    // Update context with provider info and reuse the same hash
    context.providerId = selectedProviderId
    context.providerName = provider.name
    pendingModelContexts.set(contextHash, context)

    const options = recentModels.map((model) => {
      const dateStr = model.releaseDate
        ? new Date(model.releaseDate).toLocaleDateString()
        : 'Unknown date'
      return {
        label: model.name.slice(0, 100),
        value: model.id,
        description: dateStr.slice(0, 100),
      }
    })

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`model_select:${contextHash}`)
      .setPlaceholder('Select a model')
      .addOptions(options)

    const actionRow =
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

    await interaction.editReply({
      content: `**Set Model Preference**\nProvider: **${provider.name}**\nSelect a model:`,
      components: [actionRow],
    })
  } catch (error) {
    modelLogger.error('Error loading models:', error)
    await interaction.editReply({
      content: `Failed to load models: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

/**
 * Handle the model select menu interaction.
 * If model has variants, shows variant picker. Otherwise stores model preference directly.
 */
export async function handleModelSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('model_select:')) {
    return
  }

  // Defer update immediately
  await interaction.deferUpdate()

  const contextHash = customId.replace('model_select:', '')
  const context = pendingModelContexts.get(contextHash)

  // Check if context exists, has required fields, and is not expired
  if (
    !context ||
    !context.providerId ||
    !context.providerName ||
    Date.now() - context.createdAt > PENDING_CONTEXT_TTL_MS
  ) {
    if (context) {
      pendingModelContexts.delete(contextHash)
    }
    await interaction.editReply({
      content: 'Selection expired. Please run /model again.',
      components: [],
    })
    return
  }

  const selectedModelId = interaction.values[0]
  if (!selectedModelId) {
    await interaction.editReply({
      content: 'No model selected',
      components: [],
    })
    return
  }

  // Build full model ID: provider_id/model_id
  const fullModelId = `${context.providerId}/${selectedModelId}`

  try {
    // Fetch model metadata to check for variants
    const clientV2 = getOpencodeClientV2(context.dir)
    if (!clientV2) {
      await interaction.editReply({
        content: 'Failed to connect to OpenCode server',
        components: [],
      })
      return
    }

    const { data: providersData, error: providersError } =
      await clientV2.provider.list({
        directory: context.dir,
      })

    if (providersError || !providersData) {
      modelLogger.error('[MODEL] Failed to fetch providers:', providersError)
      await interaction.editReply({
        content: 'Failed to fetch model metadata',
        components: [],
      })
      return
    }

    const provider = providersData.all.find((p) => {
      return p.id === context.providerId
    })
    const model = provider?.models[selectedModelId]
    const modelName = model?.name || selectedModelId

    // Check if model has variants
    const variants = model?.variants
    const hasVariants = variants && Object.keys(variants).length > 0
    const variantOptions = hasVariants ? buildVariantOptions(variants) : []
    const hasEnabledVariants = variantOptions.length > 1 // More than just "Default"

    if (hasEnabledVariants) {
      // Model has variants - show variant picker
      const variantContextHash = crypto.randomBytes(8).toString('hex')
      const variantContext: ModelVariantContext = {
        dir: context.dir,
        channelId: context.channelId,
        sessionId: context.sessionId,
        isThread: context.isThread,
        providerId: context.providerId,
        providerName: context.providerName,
        modelId: selectedModelId,
        modelName,
        thread: context.thread,
        createdAt: Date.now(),
      }
      pendingModelVariantContexts.set(variantContextHash, variantContext)

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`model_variant:${variantContextHash}`)
        .setPlaceholder('Select a variant')
        .addOptions(variantOptions)

      const actionRow =
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          selectMenu,
        )

      await interaction.editReply({
        content: `**Set Model Preference**\nProvider: **${context.providerName}**\nModel: **${modelName}**\nSelect a variant:`,
        components: [actionRow],
      })

      // Clean up model context
      pendingModelContexts.delete(contextHash)
      return
    }

    // No variants - persist model directly and clear any existing variant
    if (context.isThread && context.sessionId) {
      setSessionModel(context.sessionId, fullModelId)
      clearSessionVariant(context.sessionId)
      modelLogger.log(
        `Set model ${fullModelId} for session ${context.sessionId} (no variants)`,
      )

      let retried = false
      if (context.thread) {
        retried = await abortAndRetrySession({
          sessionId: context.sessionId,
          thread: context.thread,
          projectDirectory: context.dir,
          channelId: context.channelId,
        })
      }

      if (retried) {
        await interaction.editReply({
          content: `Model changed for this session:\n**${context.providerName}** / **${modelName}**\n\n\`${fullModelId}\`\n\n_Retrying current request with new model..._`,
          components: [],
        })
      } else {
        await interaction.editReply({
          content: `Model preference set for this session:\n**${context.providerName}** / **${modelName}**\n\n\`${fullModelId}\``,
          components: [],
        })
      }
    } else {
      setChannelModel(context.channelId, fullModelId)
      clearChannelVariant(context.channelId)
      modelLogger.log(
        `Set model ${fullModelId} for channel ${context.channelId} (no variants)`,
      )

      await interaction.editReply({
        content: `Model preference set for this channel:\n**${context.providerName}** / **${modelName}**\n\n\`${fullModelId}\`\n\nAll new sessions in this channel will use this model.`,
        components: [],
      })
    }

    pendingModelContexts.delete(contextHash)
  } catch (error) {
    modelLogger.error('Error saving model preference:', error)
    await interaction.editReply({
      content: `Failed to save model preference: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

/**
 * Handle the model variant select menu interaction.
 * Stores both model and variant preference.
 */
export async function handleModelVariantSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('model_variant:')) {
    return
  }

  await interaction.deferUpdate()

  const contextHash = customId.replace('model_variant:', '')
  const context = pendingModelVariantContexts.get(contextHash)

  // Check if context exists and is not expired
  if (!context || Date.now() - context.createdAt > PENDING_CONTEXT_TTL_MS) {
    if (context) {
      pendingModelVariantContexts.delete(contextHash)
    }
    await interaction.editReply({
      content: 'Selection expired. Please run /model again.',
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
    const fullModelId = `${context.providerId}/${context.modelId}`
    const isDefault = selectedVariant === '__default__'
    const variantDisplay = isDefault ? 'Default' : selectedVariant

    if (context.isThread && context.sessionId) {
      // Session-level: persist model + variant
      setSessionModel(context.sessionId, fullModelId)
      if (isDefault) {
        clearSessionVariant(context.sessionId)
      } else {
        setSessionVariant(context.sessionId, selectedVariant)
      }
      modelLogger.log(
        `Set model ${fullModelId} + variant ${variantDisplay} for session ${context.sessionId}`,
      )

      let retried = false
      if (context.thread) {
        retried = await abortAndRetrySession({
          sessionId: context.sessionId,
          thread: context.thread,
          projectDirectory: context.dir,
          channelId: context.channelId,
        })
      }

      if (retried) {
        await interaction.editReply({
          content: `Model changed for this session:\n**${context.providerName}** / **${context.modelName}** / **${variantDisplay}**\n\n\`${fullModelId}\`\n\n_Retrying current request with new model..._`,
          components: [],
        })
      } else {
        await interaction.editReply({
          content: `Model preference set for this session:\n**${context.providerName}** / **${context.modelName}** / **${variantDisplay}**\n\n\`${fullModelId}\``,
          components: [],
        })
      }
    } else {
      // Channel-level: persist model + variant
      setChannelModel(context.channelId, fullModelId)
      if (isDefault) {
        clearChannelVariant(context.channelId)
      } else {
        setChannelVariant(context.channelId, selectedVariant)
      }
      modelLogger.log(
        `Set model ${fullModelId} + variant ${variantDisplay} for channel ${context.channelId}`,
      )

      await interaction.editReply({
        content: `Model preference set for this channel:\n**${context.providerName}** / **${context.modelName}** / **${variantDisplay}**\n\n\`${fullModelId}\`\n\nAll new sessions in this channel will use this model.`,
        components: [],
      })
    }

    pendingModelVariantContexts.delete(contextHash)
  } catch (error) {
    modelLogger.error('Error saving model+variant preference:', error)
    await interaction.editReply({
      content: `Failed to save model preference: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}
