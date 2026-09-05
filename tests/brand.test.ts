import { describe, expect, test } from 'vitest'
import { BRAND_NAME } from '../src/brand.js'
import { BRAND_NAME as UI_BRAND_NAME } from '../src/ui/constants.js'

/**
 * `BRAND_NAME` moved out of `src/ui/constants.ts` (phase 1, task 1) so the
 * install/service surfaces can name the product without importing `src/ui/**`
 * — a boundary the architecture tests enforce (ADR-0004). The UI keeps
 * re-exporting it, so both spellings must stay the same string.
 */
describe('brand name', () => {
  test('is the same value whether imported from the brand module or the UI constants', () => {
    expect(UI_BRAND_NAME).toBe(BRAND_NAME)
  })

  test('is the console name the design fixed on 2026-08-22', () => {
    expect(BRAND_NAME).toBe('McpCut')
  })
})
