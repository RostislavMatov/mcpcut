import { describe, expect, test } from 'vitest'
import { displayName, renderToolName } from '../../src/ui/display-name.js'
import { render } from '../../src/ui/html.js'

/**
 * Security audit 2026-09-02, F1: a tool name arrives verbatim from an
 * untrusted MCP server and is what the approver reads before deciding.
 * `displayName` removes what renders as nothing (bidi overrides, zero-width
 * joiners, BOM, soft hyphen…) and flags anything that is not plain printable
 * ASCII, so a spoofed name is never shown unmarked. The raw name is untouched
 * everywhere else (policy matching, journal, hidden form fields).
 *
 * Every special code point is built from its number: a literal one would be
 * invisible in this file — the very trick under test.
 */

const RTL_OVERRIDE = String.fromCodePoint(0x202e)
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d)
const BOM = String.fromCodePoint(0xfeff)
const SOFT_HYPHEN = String.fromCodePoint(0x00ad)
const CYRILLIC_I = String.fromCodePoint(0x0456)
const COMBINING_ACUTE = String.fromCodePoint(0x0301)

describe('displayName', () => {
  test('removes a right-to-left override and flags the name', () => {
    // Arrange
    const raw = `read_file${RTL_OVERRIDE}txt.exe`

    // Act
    const shown = displayName(raw)

    // Assert
    expect(shown.text).toBe('read_filetxt.exe')
    expect(shown.isFlagged).toBe(true)
  })

  test('removes a zero-width joiner and flags the name', () => {
    const shown = displayName(`dele${ZERO_WIDTH_JOINER}te_all`)

    expect(shown.text).toBe('delete_all')
    expect(shown.isFlagged).toBe(true)
  })

  test('removes a BOM and a soft hyphen (format characters) and flags the name', () => {
    const shown = displayName(`${BOM}list${SOFT_HYPHEN}_issues`)

    expect(shown.text).toBe('list_issues')
    expect(shown.isFlagged).toBe(true)
  })

  test('keeps a Cyrillic homoglyph but flags the name', () => {
    const raw = `create_${CYRILLIC_I}ssue`

    const shown = displayName(raw)

    expect(shown.text).toBe(raw)
    expect(shown.isFlagged).toBe(true)
  })

  test('keeps a combining mark but flags the name', () => {
    const raw = `cre${COMBINING_ACUTE}ate_issue`

    const shown = displayName(raw)

    expect(shown.text).toBe(raw)
    expect(shown.isFlagged).toBe(true)
  })

  test('leaves a plain ASCII name untouched and unflagged', () => {
    const shown = displayName('create_issue')

    expect(shown.text).toBe('create_issue')
    expect(shown.isFlagged).toBe(false)
  })

  test('an empty name is empty and unflagged', () => {
    const shown = displayName('')

    expect(shown.text).toBe('')
    expect(shown.isFlagged).toBe(false)
  })

  test('does not mutate its input', () => {
    const raw = `read_file${RTL_OVERRIDE}txt.exe`

    displayName(raw)

    expect(raw).toContain(RTL_OVERRIDE)
  })
})

describe('renderToolName', () => {
  test('a plain name renders as bare escaped text with no badge', () => {
    expect(render(renderToolName('create_issue'))).toBe('create_issue')
  })

  test('a hostile name is HTML-escaped and stripped before the badge is appended', () => {
    const out = render(renderToolName(`<b>${RTL_OVERRIDE}</b>`))

    expect(out).not.toContain('<b>')
    expect(out).not.toContain(RTL_OVERRIDE)
    expect(out).toContain('&lt;b&gt;&lt;/b&gt;')
    expect(out).toContain('class="name-flag"')
  })

  test('the badge is an accessible, explained warning that follows the shown text', () => {
    const out = render(renderToolName(`create_${CYRILLIC_I}ssue`))

    expect(out).toMatch(
      new RegExp(`^create_${CYRILLIC_I}ssue<span class="name-flag" role="img" aria-label="[^"]+" title="[^"]+">⚠</span>$`, 'u'),
    )
  })
})
