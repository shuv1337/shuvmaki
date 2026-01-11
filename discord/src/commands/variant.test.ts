// Tests for buildVariantOptions helper function
// Validates: 24+Default limit, disabled filtering, alphabetical sorting, description handling

import { describe, test, expect } from 'bun:test'
import { buildVariantOptions } from './variant.js'

describe('buildVariantOptions', () => {
  test('filters out disabled variants', () => {
    const variants = {
      enabled1: { description: 'First enabled' },
      disabled1: { disabled: true, description: 'Disabled variant' },
      enabled2: { description: 'Second enabled' },
      disabled2: { disabled: true },
    }

    const options = buildVariantOptions(variants)

    // Should have 2 enabled + 1 Default
    expect(options.length).toBe(3)
    expect(options.map((o) => o.value)).toEqual([
      'enabled1',
      'enabled2',
      '__default__',
    ])
  })

  test('sorts variants alphabetically by key', () => {
    const variants = {
      zebra: { description: 'Z variant' },
      alpha: { description: 'A variant' },
      mike: { description: 'M variant' },
    }

    const options = buildVariantOptions(variants)

    expect(options.map((o) => o.value)).toEqual([
      'alpha',
      'mike',
      'zebra',
      '__default__',
    ])
  })

  test('limits to 24 variants plus Default (25 total)', () => {
    const variants: Record<string, { description: string }> = {}
    for (let i = 0; i < 30; i++) {
      const key = `variant_${String(i).padStart(2, '0')}`
      variants[key] = { description: `Variant ${i}` }
    }

    const options = buildVariantOptions(variants)

    // 24 variants + 1 Default = 25 total
    expect(options.length).toBe(25)
    // Default should be at the end
    expect(options[options.length - 1]?.value).toBe('__default__')
    // Should have first 24 alphabetically
    expect(options[0]?.value).toBe('variant_00')
    expect(options[23]?.value).toBe('variant_23')
  })

  test('adds Default option at the end', () => {
    const variants = {
      basic: { description: 'Basic variant' },
    }

    const options = buildVariantOptions(variants)

    expect(options.length).toBe(2)
    expect(options[1]).toEqual({
      label: 'Default',
      value: '__default__',
      description: 'Use model without a specific variant',
    })
  })

  test('uses description from variant metadata', () => {
    const variants = {
      thinking: { description: 'Extended thinking mode' },
    }

    const options = buildVariantOptions(variants)

    expect(options[0]).toEqual({
      label: 'thinking',
      value: 'thinking',
      description: 'Extended thinking mode',
    })
  })

  test('uses fallback description when not provided', () => {
    const variants = {
      basic: {},
    }

    const options = buildVariantOptions(variants)

    expect(options[0]?.description).toBe('Model variant')
  })

  test('truncates label and description to 100 characters', () => {
    const longKey = 'a'.repeat(150)
    const longDescription = 'b'.repeat(150)
    const variants = {
      [longKey]: { description: longDescription },
    }

    const options = buildVariantOptions(variants)

    expect(options[0]?.label.length).toBe(100)
    expect(options[0]?.description.length).toBe(100)
    expect(options[0]?.value).toBe(longKey) // value is not truncated
  })

  test('handles empty variants object', () => {
    const options = buildVariantOptions({})

    // Only Default option
    expect(options.length).toBe(1)
    expect(options[0]?.value).toBe('__default__')
  })

  test('handles all variants disabled', () => {
    const variants = {
      disabled1: { disabled: true },
      disabled2: { disabled: true },
    }

    const options = buildVariantOptions(variants)

    // Only Default option
    expect(options.length).toBe(1)
    expect(options[0]?.value).toBe('__default__')
  })

  test('disabled=false is treated as enabled', () => {
    const variants = {
      explicitlyEnabled: { disabled: false, description: 'Explicitly enabled' },
      disabled: { disabled: true },
    }

    const options = buildVariantOptions(variants)

    expect(options.length).toBe(2)
    expect(options[0]?.value).toBe('explicitlyEnabled')
    expect(options[1]?.value).toBe('__default__')
  })
})
