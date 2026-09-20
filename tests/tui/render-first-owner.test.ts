import { describe, expect, test } from 'vitest'
import { plainStyle } from '../../src/tui/ansi.js'
import { MIN_COLUMNS, MIN_ROWS, QUIT_WITH_TOKEN_QUESTION } from '../../src/tui/constants.js'
import {
  FIRST_OWNER_BUSY_TEXT,
  FIRST_OWNER_FOOTER,
  FIRST_OWNER_TITLE,
  FIRST_OWNER_TOKEN_QUESTION,
} from '../../src/tui/constants-live.js'
import type { Model, Msg } from '../../src/tui/model.js'
import { render } from '../../src/tui/render.js'
import { update } from '../../src/tui/update.js'
import { firstOwnerModel } from '../../src/tui/update-first-owner.js'

/** The first-owner screen as frames: every frame is exactly the terminal, and the token is whole. */

const TOKEN = `mcpa_${'A'.repeat(43)}`

function typed(model: Model, text: string): Model {
  return [...text].reduce((next, char) => update(next, { kind: 'key', key: { kind: 'char', char } }).model, model)
}

function held(size: { columns: number; rows: number }): Model {
  const busy = update(typed(firstOwnerModel(size), 'alice'), { kind: 'key', key: { kind: 'enter' } }).model
  const answer: Msg = {
    kind: 'first-owner-result',
    result: { argv: [], display: [], exitCode: 0, stdout: `admin: alice\nrole: owner\ntoken: ${TOKEN}\n`, stderr: '' },
  }
  return update(busy, answer).model
}

function frameOf(model: Model): readonly string[] {
  return render(model, plainStyle)
}

describe('render: the first-owner screen', () => {
  test('the form names what it is for, shows the typed name and its keys, and fills the terminal exactly', () => {
    const frame = frameOf(typed(firstOwnerModel({ columns: 80, rows: 24 }), 'alice'))

    expect(frame).toHaveLength(24)
    expect(frame.every((line) => line.length === 80)).toBe(true)
    const text = frame.join('\n')
    expect(text).toContain(FIRST_OWNER_TITLE)
    expect(text).toContain('Name: alice')
    expect(frame.at(-1)).toContain(FIRST_OWNER_FOOTER)
  })

  test('a refused name says why under the field', () => {
    const model = update(typed(firstOwnerModel({ columns: 80, rows: 24 }), 'Bad Name'), {
      kind: 'key',
      key: { kind: 'enter' },
    }).model

    expect(frameOf(model).join('\n')).toContain('must match')
  })

  test('while the command runs the field says so', () => {
    const model = update(typed(firstOwnerModel({ columns: 80, rows: 24 }), 'alice'), {
      kind: 'key',
      key: { kind: 'enter' },
    }).model

    expect(frameOf(model).join('\n')).toContain(FIRST_OWNER_BUSY_TEXT)
  })

  test('escape bytes typed into the name never reach a frame', () => {
    const frame = frameOf(typed(firstOwnerModel({ columns: 80, rows: 24 }), 'a\x1b[31mb'))

    expect(frame.join('\n')).not.toContain('\x1b')
  })

  test.each([
    { columns: 120, rows: 30 },
    { columns: 80, rows: 24 },
    { columns: 60, rows: 20 },
  ])('the held token is whole on one line at $columns columns, with the question under it', (size) => {
    const frame = frameOf(held(size))

    expect(frame).toHaveLength(size.rows)
    expect(frame.some((line) => line.includes(TOKEN))).toBe(true)
    expect(frame.join(' ').replace(/\s+/g, ' ')).toContain(FIRST_OWNER_TOKEN_QUESTION)
  })

  test('at the smallest terminal the console runs on, both stages still fill it exactly and the token is whole', () => {
    const floor = { columns: MIN_COLUMNS, rows: MIN_ROWS }

    for (const model of [firstOwnerModel(floor), held({ columns: 60, rows: MIN_ROWS })]) {
      const frame = frameOf(model)
      expect(frame).toHaveLength(model.size.rows)
      expect(frame.every((line) => line.length === model.size.columns)).toBe(true)
    }
    expect(frameOf(held({ columns: 60, rows: MIN_ROWS })).some((line) => line.includes(TOKEN))).toBe(true)
  })

  test('q swaps the question for the one that guards the token', () => {
    const asked = update(held({ columns: 80, rows: 24 }), { kind: 'key', key: { kind: 'char', char: 'q' } }).model

    const text = frameOf(asked).join(' ').replace(/\s+/g, ' ')
    expect(text).toContain(QUIT_WITH_TOKEN_QUESTION)
    expect(text).toContain(TOKEN)
  })
})

describe('render: the first-owner screen over --remote (ADR-0014)', () => {
  const REMOTE_INSTALL = { supervisor: 'mcpcut' as const, remote: true as const }
  const SIZE = { columns: 80, rows: 24 }

  function remoteModel(): Model {
    return firstOwnerModel(SIZE, REMOTE_INSTALL)
  }

  function typedInto(model: Model, text: string): Model {
    return typed(model, text)
  }

  test('the code is masked — never drawn as itself — and the name is drawn as typed', () => {
    const withCode = typedInto(remoteModel(), 'mcps_super-secret')
    const movedToName = update(withCode, { kind: 'key', key: { kind: 'tab' } }).model
    const filled = typedInto(movedToName, 'alice')

    const text = frameOf(filled).join('\n')

    expect(text).not.toContain('mcps_super-secret')
    expect(text).toContain('alice')
  })

  test('a refusal message from the server is shown on the form', () => {
    const withCode = typedInto(remoteModel(), 'mcps_wrong')
    const movedToName = update(withCode, { kind: 'key', key: { kind: 'tab' } }).model
    const filled = typedInto(movedToName, 'alice')
    const busy = update(filled, { kind: 'key', key: { kind: 'enter' } }).model
    const refused = update(busy, {
      kind: 'first-owner-setup-result',
      result: { kind: 'refused', message: 'code-refused: try again' },
    }).model

    expect(frameOf(refused).join('\n')).toContain('code-refused: try again')
  })

  test('shows the remote address, since this is the very first screen an operator sees', () => {
    const addressed: Model = {
      ...remoteModel(),
      install: { ...REMOTE_INSTALL, remoteAddress: 'https://mcp.example.com' },
    }

    expect(frameOf(addressed).join('\n')).toContain('https://mcp.example.com')
  })

  test('the FORM footer names Ctrl-D disconnect (2026-09-20)', () => {
    expect(frameOf(remoteModel()).at(-1)).toContain('Ctrl-D disconnect')
  })

  test('a local console never shows the chord', () => {
    expect(frameOf(firstOwnerModel(SIZE)).at(-1)).not.toContain('Ctrl-D')
  })

  test('the token-hold stage never shows the chord: it must not answer to a stray one', () => {
    const withCode = typedInto(remoteModel(), 'mcps_ok')
    const movedToName = update(withCode, { kind: 'key', key: { kind: 'tab' } }).model
    const filled = typedInto(movedToName, 'alice')
    const busy = update(filled, { kind: 'key', key: { kind: 'enter' } }).model
    const heldStage = update(busy, {
      kind: 'first-owner-setup-result',
      result: { kind: 'ok', name: 'alice', token: TOKEN, journaled: true },
    }).model

    expect(frameOf(heldStage).at(-1)).not.toContain('Ctrl-D')
  })

  test('an unjournalled mint shows the audit-record-dropped warning beside the token', () => {
    const withCode = typedInto(remoteModel(), 'mcps_ok')
    const movedToName = update(withCode, { kind: 'key', key: { kind: 'tab' } }).model
    const filled = typedInto(movedToName, 'alice')
    const busy = update(filled, { kind: 'key', key: { kind: 'enter' } }).model
    const held = update(busy, {
      kind: 'first-owner-setup-result',
      result: { kind: 'ok', name: 'alice', token: TOKEN, journaled: false },
    }).model

    const text = frameOf(held).join(' ').replace(/\s+/g, ' ')
    expect(text).toContain('audit record was NOT written')
    expect(text).toContain(TOKEN)
  })
})
