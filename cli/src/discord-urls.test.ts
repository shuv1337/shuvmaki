import { describe, expect, test } from 'vitest'
import { resolveDiscordBaseUrl } from './discord-urls.js'

describe('resolveDiscordBaseUrl', () => {
  test('prefers an explicitly configured gateway over the saved proxy', () => {
    expect(
      resolveDiscordBaseUrl({
        isGatewayMode: true,
        savedProxyUrl: 'https://gateway.example.com/',
        configuredGatewayUrl: 'ws://127.0.0.1:7878',
      }),
    ).toBe('http://127.0.0.1:7878/')
  })

  test('uses the saved proxy when no gateway override is configured', () => {
    expect(
      resolveDiscordBaseUrl({
        isGatewayMode: true,
        savedProxyUrl: 'https://gateway.example.com/',
      }),
    ).toBe('https://gateway.example.com/')
  })

  test('uses Discord directly in self-hosted mode', () => {
    expect(
      resolveDiscordBaseUrl({
        isGatewayMode: false,
        savedProxyUrl: 'https://gateway.example.com/',
        configuredGatewayUrl: 'ws://127.0.0.1:7878',
      }),
    ).toBe('https://discord.com')
  })
})
