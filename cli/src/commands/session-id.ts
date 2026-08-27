// /session-id command - Show current session ID and a kimaki attach command.

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import {
  getOpencodeServerPort,
  initializeOpencodeForDirectory,
} from '../opencode.js'
import { getDataDir } from '../config.js'
import { buildKimakiAttachCommand } from '../shuvcode-server-auth.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.SESSION)

export function buildSessionIdAttachReply({
  sessionId,
  directory,
  dataDir,
}: {
  sessionId: string
  directory: string
  dataDir?: string
}) {
  const attachCommand = buildKimakiAttachCommand({
    sessionId,
    directory,
    dataDir,
  })
  return `**Session ID:** \`${sessionId}\`\n**Attach command:**\n\`\`\`bash\n${attachCommand}\n\`\`\``
}

export async function handleSessionIdCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory, workingDirectory } = resolved
  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  let port = getOpencodeServerPort(projectDirectory)
  if (!port) {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await command.editReply({
        content: `Session ID: \`${sessionId}\`\nFailed to resolve shuvcode server port: ${getClient.message}`,
      })
      return
    }
    port = getOpencodeServerPort(projectDirectory)
  }

  if (!port) {
    await command.editReply({
      content: `Session ID: \`${sessionId}\`\nCould not determine shuvcode server port`,
    })
    return
  }

  await command.editReply({
    content: buildSessionIdAttachReply({
      sessionId,
      directory: workingDirectory,
      dataDir: getDataDir(),
    }),
  })
  logger.log(`Session ID shown for thread ${channel.id}: ${sessionId}`)
}
