import { describe, expect, test } from 'vitest'
import { REMOTE_AUDIT_RECORD_DROPPED_WARNING } from '../../src/tui/constants-live.js'
import type { KeyEvent } from '../../src/tui/keys.js'
import type { FirstOwnerRemoteOutcome, Model, Msg, Step } from '../../src/tui/model.js'
import { update } from '../../src/tui/update.js'
import { firstOwnerModel } from '../../src/tui/update-first-owner.js'
import { AUDIT_RECORD_DROPPED_WARNING } from '../../src/ui/constants.js'

/**
 * The first-owner screen over `--remote` (ADR-0014, plan wave 2 task 5): a
 * code plus a name, `POST setup` instead of a tokenless `admin add`, and the
 * SAME token-hold code path once an owner exists.
 */

const SIZE = { columns: 80, rows: 24 }
const REMOTE_INSTALL = { supervisor: 'mcpcut' as const, remote: true as const }
const TOKEN = 'mcpa_remote-console-owner'

function key(event: KeyEvent): Msg {
  return { kind: 'key', key: event }
}

function typed(model: Model, text: string): Model {
  return [...text].reduce((next, char) => update(next, key({ kind: 'char', char })).model, model)
}

function typedIntoBothFields(model: Model, code: string, name: string): Model {
  const withCode = typed(model, code)
  const movedToName = update(withCode, key({ kind: 'tab' })).model
  return typed(movedToName, name)
}

function remoteModel(): Model {
  return firstOwnerModel(SIZE, REMOTE_INSTALL)
}

function submitted(code: string, name: string): Step {
  const filled = typedIntoBothFields(remoteModel(), code, name)
  return update(filled, key({ kind: 'enter' }))
}

function outcome(result: FirstOwnerRemoteOutcome): Msg {
  return { kind: 'first-owner-setup-result', result }
}

describe('first-owner over --remote: an extra masked code field', () => {
  test('the form has a code field before the name field', () => {
    const model = remoteModel()
    const screen = model.screen

    expect(screen.kind === 'first-owner' && screen.stage.kind === 'form' && screen.stage.form.fields.map((f) => f.spec.name)).toEqual([
      'code',
      'name',
    ])
    expect(screen.kind === 'first-owner' && screen.stage.kind === 'form' && screen.stage.form.fields[0]?.spec.kind).toBe(
      'secret',
    )
  })

  test('the local (non-remote) form still carries only name', () => {
    const model = firstOwnerModel(SIZE)
    const screen = model.screen

    expect(screen.kind === 'first-owner' && screen.stage.kind === 'form' && screen.stage.form.fields.map((f) => f.spec.name)).toEqual([
      'name',
    ])
  })
})

describe('first-owner over --remote: submit calls `POST setup`, never `admin add`', () => {
  test('Enter with a code and a name asks for `first-owner-setup`, not `first-owner-run`', () => {
    const step = submitted('mcps_abcdef', 'alice')

    expect(step.effects).toEqual([{ kind: 'first-owner-setup', code: 'mcps_abcdef', name: 'alice' }])
  })

  test('the code never survives submit in the model — not even in a stray field', () => {
    const step = submitted('mcps_super-secret-code', 'alice')

    expect(JSON.stringify(step.model)).not.toContain('mcps_super-secret-code')
  })

  test('a blank code refuses to submit, same as a blank name', () => {
    const model = typedIntoBothFields(remoteModel(), '', 'alice')

    const step = update(model, key({ kind: 'enter' }))

    expect(step.effects).toEqual([])
  })

  test('a second Enter while busy does nothing', () => {
    const busy = submitted('mcps_abcdef', 'alice').model

    expect(update(busy, key({ kind: 'enter' })).effects).toEqual([])
  })
})

describe('first-owner over --remote: the answer', () => {
  test('ok holds the token exactly the way a local mint would', () => {
    const busy = submitted('mcps_abcdef', 'alice').model

    const step = update(busy, outcome({ kind: 'ok', name: 'alice', token: TOKEN, journaled: true }))

    const screen = step.model.screen
    expect(screen.kind === 'first-owner' && screen.stage).toEqual({
      kind: 'hold',
      admin: { name: 'alice', token: TOKEN },
      quitAsked: false,
    })
  })

  test('journaled: false surfaces the audit-record-dropped warning on the hold stage', () => {
    const busy = submitted('mcps_abcdef', 'alice').model

    const step = update(busy, outcome({ kind: 'ok', name: 'alice', token: TOKEN, journaled: false }))

    const screen = step.model.screen
    expect(screen.kind === 'first-owner' && screen.stage.kind === 'hold' && screen.stage.warning).toBeTruthy()
  })

  test.each(['code-refused', 'invalid-name', 'rate-limited'] as const)(
    '%s keeps the operator on the (now empty) form with the message',
    (kind) => {
      const busy = submitted('mcps_abcdef', 'alice').model

      const step = update(busy, outcome({ kind: 'refused', message: `${kind}: try again` }))

      const screen = step.model.screen
      expect(screen.kind).toBe('first-owner')
      expect(screen.kind === 'first-owner' && screen.stage.kind === 'form' && screen.stage.notice).toBe(
        `${kind}: try again`,
      )
      expect(screen.kind === 'first-owner' && screen.stage.kind === 'form' && screen.stage.busy).toBe(false)
    },
  )

  test('closed sends the operator to the sign-in screen', () => {
    const busy = submitted('mcps_abcdef', 'alice').model

    const step = update(busy, outcome({ kind: 'closed' }))

    expect(step.model.screen.kind).toBe('signin')
  })
})

describe('the console mirrors, byte for byte, the web UI’s audit-record-dropped warning', () => {
  test('the console cannot import src/ui/**, so the sentence is duplicated — a test keeps the two in sync', () => {
    expect(REMOTE_AUDIT_RECORD_DROPPED_WARNING).toBe(AUDIT_RECORD_DROPPED_WARNING)
  })
})

describe('first-owner over --remote: holding the token behaves exactly as locally', () => {
  function held(): Model {
    const busy = submitted('mcps_abcdef', 'alice').model
    return update(busy, outcome({ kind: 'ok', name: 'alice', token: TOKEN, journaled: true })).model
  }

  test('y signs in with the token it holds', () => {
    const step = update(held(), key({ kind: 'char', char: 'y' }))

    expect(step.effects).toEqual([{ kind: 'signin', token: TOKEN }])
  })

  test('q asks first', () => {
    const asked = update(held(), key({ kind: 'char', char: 'q' }))

    expect(asked.model.screen.kind === 'first-owner' && asked.model.screen.stage).toMatchObject({ quitAsked: true })
  })
})

/**
 * Ctrl-D on the remote first-owner FORM stage (2026-09-20, owner request "a
 * way to disconnect"): the same effect Home's `disconnect` asks for, but the
 * token-hold stage must never hear it — the one-time token would otherwise be
 * lost to a stray chord.
 */
describe('first-owner over --remote: Ctrl-D disconnects', () => {
  const CTRL_D: KeyEvent = { kind: 'ctrl', char: 'd' }

  function heldModel(): Model {
    const busy = submitted('mcps_abcdef', 'alice').model
    return update(busy, outcome({ kind: 'ok', name: 'alice', token: TOKEN, journaled: true })).model
  }

  test('on the form, not busy: forgets nothing itself, reopens on --connect', () => {
    const model = firstOwnerModel(SIZE, { supervisor: 'mcpcut', remote: true, remoteAddress: 'https://box:8091' })

    const step = update(model, key(CTRL_D))

    expect(step.effects).toEqual([{ kind: 'disconnect', argv: ['--connect', 'https://box:8091'] }])
  })

  test('is ignored while a submission is in flight', () => {
    const busy = submitted('mcps_abcdef', 'alice').model

    const step = update(busy, key(CTRL_D))

    expect(step.effects).toEqual([])
  })

  test('is ignored on the token-hold stage: the token must not be lost to a stray chord', () => {
    const step = update(heldModel(), key(CTRL_D))

    expect(step.effects).toEqual([])
    expect(step.model.screen.kind).toBe('first-owner')
    expect(step.model.screen.kind === 'first-owner' && step.model.screen.stage.kind).toBe('hold')
  })

  test('does nothing on a LOCAL console: it is not remote, so the chord falls through unhandled', () => {
    const model = firstOwnerModel(SIZE)

    const step = update(model, key(CTRL_D))

    expect(step.effects).toEqual([])
    expect(step.model).toEqual(model)
  })
})
