import { expect } from 'vitest'

/**
 * The project's refused-words rule (CLAUDE.md): never "tamper-proof" or
 * "audit-ready", and "tamper-evident" only when "external anchor" appears
 * shortly after it — the journal's real guarantee is an external anchor
 * making a rewrite DETECTABLE, not a promise the file cannot be rewritten.
 *
 * Originally two inline tests in `tests/site/landing.test.ts`; pulled out
 * here so `tests/hub/pages.test.ts` (Terms/Privacy, plan `hub-signin-
 * accounts` Task 4) checks the same rule instead of a copy that can drift.
 */

/** How far after "tamper-evident" the qualifier may stand (characters of text). */
const QUALIFIER_WINDOW = 80

/** Asserts `text` never says "tamper-proof"/"audit-ready" and qualifies every "tamper-evident". */
export function expectNoBannedWords(text: string): void {
  expect(text).not.toMatch(/tamper[- ]?proof/i)
  expect(text).not.toMatch(/audit[- ]?ready/i)
  const lower = text.toLowerCase()
  let at = lower.indexOf('tamper-evident')
  while (at !== -1) {
    const window = lower.slice(at, at + QUALIFIER_WINDOW)
    expect(window, `"${text.slice(at, at + QUALIFIER_WINDOW)}"`).toContain('external anchor')
    at = lower.indexOf('tamper-evident', at + 1)
  }
}
