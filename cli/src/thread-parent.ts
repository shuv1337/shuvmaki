import type { Client } from 'discord.js'
import { DiscordOperationError } from './errors.js'

export async function resolveThreadParentId({
  channelId,
  cachedParentId,
  client,
}: {
  channelId: string
  cachedParentId: string | null
  client: Client<boolean>
}): Promise<string | null> {
  if (cachedParentId) {
    return cachedParentId
  }

  const fetched = await client.channels
    .fetch(channelId)
    .catch((error) => new DiscordOperationError({ operation: 'fetchChannel', cause: error }))
  if (!(fetched instanceof Error) && fetched?.isThread()) {
    return fetched.parentId
  }
  return null
}
