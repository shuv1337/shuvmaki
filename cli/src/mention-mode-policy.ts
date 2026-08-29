export function isDirectReplyToBotMessage({
  repliedUserId,
  botUserId,
}: {
  repliedUserId: string | undefined
  botUserId: string | undefined
}) {
  return Boolean(botUserId && repliedUserId === botUserId)
}

export function shouldIgnoreMentionModeThreadMessage({
  mentionModeEnabled,
  botMentioned,
  isDirectReplyToBot,
  isShellCommand,
  isContextOnlyMessage,
}: {
  mentionModeEnabled: boolean
  botMentioned: boolean
  isDirectReplyToBot: boolean
  isShellCommand: boolean
  isContextOnlyMessage: boolean
}) {
  if (!mentionModeEnabled) return false
  if (isContextOnlyMessage) return false
  if (botMentioned || isDirectReplyToBot || isShellCommand) return false
  return true
}
