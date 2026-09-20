import { describe, expect, test } from 'vitest'
import type { ActionSpec } from '../../src/tui/catalogue/types.js'
import { SECRET_DISPLAY_MASK } from '../../src/tui/constants.js'
import type { Effect, Model, RunRequest, Step } from '../../src/tui/model.js'
import { update } from '../../src/tui/update.js'
import { requestOf, stdinOf } from '../../src/tui/update-form.js'
import {
  ADMINS_TAB,
  AUDIT_PRUNE_ACTION,
  AUDIT_TAB,
  HOME_TAB,
  JOURNAL_EXPORT_ACTION,
  JOURNAL_TAB,
  NO_SUCH_TAB,
  VAULT_SECRET,
  VAULT_SET_ACTION,
  VAULT_TAB,
  char,
  key,
  mainModel,
  mainOf,
  typed,
} from './support/update-fixtures.js'

/**
 * The reducer over the panes that take input before a run: the form pane, the
 * confirmation pane, and what a submitted form puts on the request besides its
 * argv (the masked display line, `mintsToken`, `stdoutPath`, the secret on
 * stdin). Split out of `update.test.ts` (phase 6, task 9); the fixtures are in
 * `support/update-fixtures.ts`.
 */

describe('update: a form pane', () => {
  function formModel(actionIndex: number): Model {
    return update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex }), key('enter')).model
  }

  test.each([
    ['Tab', key('tab')],
    ['down', key('down')],
  ])('%s moves to the next field', (_name, msg) => {
    const step = update(formModel(1), msg)

    const pane = mainOf(step.model).pane
    expect(pane.kind === 'form' ? pane.form.focus : -1).toBe(1)
  })

  test.each([
    ['Shift-Tab', key('backtab')],
    ['up', key('up')],
  ])('%s moves to the previous field, wrapping', (_name, msg) => {
    const step = update(formModel(1), msg)

    const pane = mainOf(step.model).pane
    expect(pane.kind === 'form' ? pane.form.focus : -1).toBe(1)
  })

  test('a printable key edits the focused field', () => {
    const step = update(formModel(1), char('b'))

    const pane = mainOf(step.model).pane
    expect(pane.kind === 'form' ? pane.form.fields[0]?.value : undefined).toBe('b')
  })

  test('a form whose action is no longer reachable closes instead of running', () => {
    const opened = formModel(1)
    const orphaned = mainModel({ pane: mainOf(opened).pane, sectionIndex: NO_SUCH_TAB })

    const step = update(typed(orphaned, 'bob'), key('enter'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(step.effects).toEqual([])
  })

  test('Escape closes the form without running anything', () => {
    const step = update(formModel(1), key('escape'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(step.effects).toEqual([])
  })

  test('Enter on an invalid value keeps the form and shows the error', () => {
    const step = update(typed(formModel(1), 'Bad Name'), key('enter'))

    const pane = mainOf(step.model).pane
    if (pane.kind !== 'form') throw new Error('expected a form pane')
    expect(pane.form.fields[0]?.error).toContain('must match')
    expect(pane.form.focus).toBe(0)
    expect(step.effects).toEqual([])
  })

  test('Enter on an empty required value keeps the form', () => {
    const step = update(formModel(1), key('enter'))

    const pane = mainOf(step.model).pane
    expect(pane.kind === 'form' ? pane.form.fields[0]?.error : undefined).toBe('required')
  })

  test('Enter on a valid form runs the command the form builds', () => {
    const step = update(typed(formModel(1), 'bob'), key('enter'))

    const request: RunRequest = {
      actionId: 'add',
      argv: ['admin', 'add', 'bob', '--role', 'owner'],
      display: ['admin', 'add', 'bob', '--role', 'owner'],
      // `admin add` prints a token once, and that travels with the request.
      mintsToken: true,
    }
    expect(step.effects).toEqual([{ kind: 'run', request }])
    expect(mainOf(step.model).busy).toEqual(request)
    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
  })

  test('the arrows pick a role before the command is built', () => {
    const named = typed(formModel(1), 'bob')
    const onRole = update(named, key('tab')).model

    const step = update(update(onRole, key('right')).model, key('enter'))

    expect(step.effects).toEqual([
      {
        kind: 'run',
        request: {
          actionId: 'add',
          argv: ['admin', 'add', 'bob', '--role', 'operator'],
          display: ['admin', 'add', 'bob', '--role', 'operator'],
          mintsToken: true,
        },
      },
    ])
  })

  test('the displayed command line is a copy, not the argv that was dispatched', () => {
    const step = update(typed(formModel(1), 'bob'), key('enter'))

    const effect = step.effects[0]
    if (effect?.kind !== 'run') throw new Error('expected a run effect')
    expect(effect.request.display).not.toBe(effect.request.argv)
  })
})

describe('update: a confirmation pane', () => {
  function confirmModel(): Model {
    const form = update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 4 }), key('enter')).model
    return update(typed(form, 'bob'), key('enter')).model
  }

  test('an action that asks first opens a question instead of running', () => {
    const model = confirmModel()

    const pane = mainOf(model).pane
    if (pane.kind !== 'confirm') throw new Error('expected a confirm pane')
    expect(pane.actionId).toBe('remove')
    expect(pane.question).toContain('Remove admin "bob"?')
    expect(pane.request.argv).toEqual(['admin', 'remove', 'bob'])
  })

  test.each([['y'], ['Y']])('%s runs the command that was asked about', (answer) => {
    const model = confirmModel()

    const step = update(model, char(answer))

    const request: RunRequest = {
      actionId: 'remove',
      argv: ['admin', 'remove', 'bob'],
      display: ['admin', 'remove', 'bob'],
    }
    expect(step.effects).toEqual([{ kind: 'run', request }])
    expect(mainOf(step.model).busy).toEqual(request)
  })

  test('any other answer cancels', () => {
    const step = update(confirmModel(), char('n'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(step.effects).toEqual([])
  })

  test('Escape cancels too', () => {
    const step = update(confirmModel(), key('escape'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(step.effects).toEqual([])
  })
})

describe('update: what a run carries besides its argv', () => {
  /** A synthetic action, so the shape being asserted is visible in the test. */
  const signAction: ActionSpec = {
    id: 'sign',
    title: 'sign',
    minRole: 'owner',
    command: 'demo',
    fields: [
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'token', label: 'Token', kind: 'secret' },
    ],
    argv: (values) => ['demo', values.name ?? '', '--token', values.token ?? ''],
  }

  /** Opens one action's form and returns the model showing it. */
  function formModel(sectionIndex: number, actionIndex: number): Model {
    return update(mainModel({ sectionIndex, actionIndex }), key('enter')).model
  }

  /** Types a value into the focused field and moves on to the next one. */
  function filled(model: Model, value: string): Model {
    return update(typed(model, value), key('tab')).model
  }

  /** The one run effect a submit is expected to have asked for. */
  function runEffectOf(step: Step): Extract<Effect, { kind: 'run' }> {
    const effect = step.effects[0]
    if (effect?.kind !== 'run') throw new Error(`expected a run effect, got ${effect?.kind ?? 'none'}`)

    return effect
  }

  test('a secret that reaches argv is masked in the displayed command line only', () => {
    // Arrange
    const values = { name: 'bob', token: 'mcpa_secret' }

    // Act
    const request = requestOf(signAction, values)

    // Assert
    expect(request.argv).toEqual(['demo', 'bob', '--token', 'mcpa_secret'])
    expect(request.display).toEqual(['demo', 'bob', '--token', SECRET_DISPLAY_MASK])
  })

  test('an action that mints a credential says so on the request it builds', () => {
    // The pane may hold a one-time token only because the ACTION mints one;
    // the marker in the output alone is text a command was handed (F1).
    const minting: ActionSpec = { ...signAction, mintsToken: true }

    expect(requestOf(minting, { name: 'bob', token: '' }).mintsToken).toBe(true)
  })

  test('an ordinary action leaves the key out entirely, rather than setting it undefined', () => {
    expect('mintsToken' in requestOf(signAction, { name: 'bob', token: '' })).toBe(false)
  })

  test('an empty secret masks nothing, so an empty argument stays an empty argument', () => {
    const request = requestOf(signAction, { name: '', token: '' })

    expect(request.display).toEqual(['demo', '', '--token', ''])
  })

  test('a padded value reaches the command line trimmed, so no file is named " out"', () => {
    // Arrange: a stray space is what a paste and an arrow key leave behind.
    const values = { name: '  bob  ', token: 'mcpa_secret' }

    // Act
    const request = requestOf(signAction, values)

    // Assert
    expect(request.argv).toEqual(['demo', 'bob', '--token', 'mcpa_secret'])
  })

  test('a secret is handed over exactly as typed: its own padding may be part of it', () => {
    const request = requestOf(signAction, { name: 'bob', token: '  mcpa_secret  ' })

    expect(request.argv).toEqual(['demo', 'bob', '--token', '  mcpa_secret  '])
    expect(request.display).toEqual(['demo', 'bob', '--token', SECRET_DISPLAY_MASK])
  })

  test('a padded output path is trimmed before the runtime opens the file', () => {
    // Arrange
    const writeAction: ActionSpec = {
      id: 'dump',
      title: 'dump',
      minRole: 'viewer',
      command: 'demo',
      fields: [{ name: 'out', label: 'Out', kind: 'text', required: true }],
      argv: () => ['demo'],
      stdoutToField: 'out',
    }

    // Act
    const request = requestOf(writeAction, { out: '  /tmp/journal.jsonl  ' })

    // Assert
    expect(request.stdoutPath).toBe('/tmp/journal.jsonl')
  })

  test('an output field holding only whitespace names no file at all', () => {
    const writeAction: ActionSpec = {
      id: 'dump',
      title: 'dump',
      minRole: 'viewer',
      command: 'demo',
      fields: [{ name: 'out', label: 'Out', kind: 'text' }],
      argv: () => ['demo'],
      stdoutToField: 'out',
    }

    expect('stdoutPath' in requestOf(writeAction, { out: '   ' })).toBe(false)
  })

  test('an action that names no output path leaves the key out of the request', () => {
    const request = requestOf(signAction, { name: 'bob', token: 'x' })

    expect('stdoutPath' in request).toBe(false)
  })

  test('an action that names no stdin field hands the runtime nothing to write', () => {
    expect(stdinOf(signAction, { name: 'bob', token: 'x' })).toBeUndefined()
  })

  test('the vault secret travels in the run effect and never enters the model', () => {
    // Arrange
    const named = filled(formModel(VAULT_TAB, VAULT_SET_ACTION), 'openai')
    const ready = typed(named, VAULT_SECRET)

    // Act
    const step = update(ready, key('enter'))

    // Assert
    const effect = runEffectOf(step)
    expect(effect.stdin).toBe(VAULT_SECRET)
    expect(effect.request.argv).toEqual(['vault', 'set', 'openai'])
    expect(mainOf(step.model).busy?.display).not.toContain(VAULT_SECRET)
    expect(JSON.stringify(step.model)).not.toContain(VAULT_SECRET)
  })

  test('journal export puts the path it was given on the request', () => {
    const ready = filled(formModel(JOURNAL_TAB, JOURNAL_EXPORT_ACTION), '/tmp/journal.jsonl')

    const step = update(ready, key('enter'))

    expect(runEffectOf(step).request.stdoutPath).toBe('/tmp/journal.jsonl')
  })

  test('a dry-run prune runs at once, because the flag it is off answers nothing', () => {
    const ready = filled(formModel(AUDIT_TAB, AUDIT_PRUNE_ACTION), '90d')

    const step = update(ready, key('enter'))

    expect(runEffectOf(step).request.argv).toEqual(['prune', '--older-than', '90d'])
    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
  })

  test('a prune that would delete asks before anything happens', () => {
    const ready = update(filled(formModel(AUDIT_TAB, AUDIT_PRUNE_ACTION), '90d'), char(' ')).model

    const step = update(ready, key('enter'))

    const pane = mainOf(step.model).pane
    if (pane.kind !== 'confirm') throw new Error('expected a confirm pane')
    expect(pane.question).toContain('Delete journal records older than 90d?')
    expect(pane.request.argv).toEqual(['prune', '--older-than', '90d', '--yes'])
    expect(step.effects).toEqual([])
  })
})

/**
 * Home's `disconnect` (2026-09-20, owner request "a way to disconnect"):
 * visible only on a remote console, dispatches nothing, and ends the console
 * on `['--connect', <the address it was connected to>]`.
 */
describe('update: Home’s disconnect action', () => {
  const REMOTE: Model['install'] = {
    supervisor: 'mcpcut',
    remote: true,
    remoteAddress: 'https://box.example:8091',
  }

  test('running it forgets nothing itself but asks the runtime to disconnect, and touches no other pane field', () => {
    const model = mainModel({ sectionIndex: HOME_TAB, actionIndex: 1 }, 'owner', REMOTE)

    const step = update(model, key('enter'))

    expect(step.effects).toEqual([{ kind: 'disconnect', argv: ['--connect', 'https://box.example:8091'] }])
    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(mainOf(step.model).busy).toBeUndefined()
  })

  test('is not offered at all on a local console', () => {
    const model = mainModel({ sectionIndex: HOME_TAB }, 'owner')

    const home = mainOf(model).sections[HOME_TAB]
    expect(home?.actions.map((action) => action.id)).toEqual(['status'])
  })

  test('is the second action of Home on a remote console', () => {
    const model = mainModel({ sectionIndex: HOME_TAB }, 'owner', REMOTE)

    const home = mainOf(model).sections[HOME_TAB]
    expect(home?.actions.map((action) => action.id)).toEqual(['status', 'disconnect'])
  })

  test('an absent remoteAddress (a wiring fault) reopens on an empty address rather than crashing', () => {
    const model = mainModel({ sectionIndex: HOME_TAB, actionIndex: 1 }, 'owner', { supervisor: 'mcpcut', remote: true })

    const step = update(model, key('enter'))

    expect(step.effects).toEqual([{ kind: 'disconnect', argv: ['--connect', ''] }])
  })
})
