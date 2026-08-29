import { describe, expect, test } from 'vitest'
import {
  isDirectReplyToBotMessage,
  shouldIgnoreMentionModeThreadMessage,
} from './mention-mode-policy.js'

const mentionModeMessage = {
  mentionModeEnabled: true,
  botMentioned: false,
  isDirectReplyToBot: false,
  isShellCommand: false,
  isContextOnlyMessage: false,
}

describe('isDirectReplyToBotMessage', () => {
  test('only matches replies to the current bot', () => {
    expect(isDirectReplyToBotMessage({ repliedUserId: 'bot-1', botUserId: 'bot-1' })).toBe(true)
    expect(isDirectReplyToBotMessage({ repliedUserId: 'human-1', botUserId: 'bot-1' })).toBe(false)
    expect(isDirectReplyToBotMessage({ repliedUserId: undefined, botUserId: 'bot-1' })).toBe(false)
  })
})

describe('shouldIgnoreMentionModeThreadMessage', () => {
  test('ignores ordinary thread chatter when mention mode is enabled', () => {
    expect(shouldIgnoreMentionModeThreadMessage(mentionModeMessage)).toBe(true)
  })

  test.each([
    { botMentioned: true },
    { isDirectReplyToBot: true },
    { isShellCommand: true },
    { isContextOnlyMessage: true },
  ])('allows an explicit or context-only message: %o', (override) => {
    expect(
      shouldIgnoreMentionModeThreadMessage({
        ...mentionModeMessage,
        ...override,
      }),
    ).toBe(false)
  })

  test('does not filter thread messages when mention mode is disabled', () => {
    expect(
      shouldIgnoreMentionModeThreadMessage({
        ...mentionModeMessage,
        mentionModeEnabled: false,
      }),
    ).toBe(false)
  })
})
