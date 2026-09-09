import { describe, expect, test } from 'vitest'
import type { Role } from '../../src/admin/authz.js'
import { parseRetentionDuration } from '../../src/cli/prune-cmd.js'
import { SESSION_ID_PATTERN } from '../../src/config.js'
import { JOURNAL_DIRECTIONS, JOURNAL_KINDS } from '../../src/journal/reader.js'
import { APPROVALS_SECTION } from '../../src/tui/catalogue/approvals.js'
import { AUDIT_SECTION } from '../../src/tui/catalogue/audit.js'
import { JOURNAL_SECTION } from '../../src/tui/catalogue/journal.js'
import { visibleActions } from '../../src/tui/catalogue/index.js'
import type { ActionSpec, SectionSpec } from '../../src/tui/catalogue/types.js'
import { ACTION_COLUMN_WIDTH, ACTIVE_MARKER, EXPORT_OUT_HINT } from '../../src/tui/constants.js'
import type { FormValues } from '../../src/tui/form.js'

/**
 * The Approvals, Journal and Audit sections (mcpcut phase 4, Task 6): the
 * three screens an operator answers a request from, reads what happened, and
 * hands an auditor the evidence with.
 *
 * Three things are load-bearing and asserted below. Every `argv` has to be a
 * command line the CLI's own parser accepts, which for these sections means
 * an unfilled optional flag VANISHES rather than travelling as an empty
 * string. `export` writes its records to a file rather than into a 2 000-line
 * pane, so the path it was given must reach the runtime as `stdoutToField`
 * and must NOT appear in argv — `export` has no `--out`, and a path smuggled
 * in there would be read as a second session id. And the thresholds mirror
 * the commands themselves: reading is `viewer`, resolving a request is
 * `APPROVAL_RESOLVE_MIN_ROLE`, and everything that signs, keys, copies or
 * deletes evidence is `owner`.
 */

const SECTIONS: readonly SectionSpec[] = [APPROVALS_SECTION, JOURNAL_SECTION, AUDIT_SECTION]
const ALL_ACTIONS: readonly ActionSpec[] = SECTIONS.flatMap((section) => section.actions)

/** Longest title the action column can print beside its marker. */
const TITLE_MAX_WIDTH = ACTION_COLUMN_WIDTH - ACTIVE_MARKER.length

/** A field's hint shares a line with its value, so it is the shortest text here. */
const FIELD_HINT_MAX_CHARS = 40

/** An action hint and an intro line each own a whole line of the output pane. */
const LINE_MAX_CHARS = 54

/** Every field of the three sections filled with something the CLI would accept. */
const FILLED: FormValues = {
  id: '01J9ZQ4T7C0000000000000000',
  reason: 'expected for the nightly job',
  session: 'plane_probe',
  method: 'tools/call',
  direction: 'client→server',
  kind: 'request',
  json: 'true',
  out: '/tmp/mcp-out',
  dir: '/tmp/report',
  pub: '/tmp/signing.pub',
  'require-signature': 'true',
  dest: '/tmp/backup',
  'older-than': '90d',
  yes: 'true',
}

/** Only what a form would refuse to run without; every optional field left blank. */
const REQUIRED_ONLY: FormValues = {
  id: '01J9ZQ4T7C0000000000000000',
  session: 'plane_probe',
  out: '/tmp/mcp-out',
  dir: '/tmp/report',
  dest: '/tmp/backup',
  'older-than': '90d',
}

/** Nothing filled at all: what an action with no required field runs as. */
const BLANK: FormValues = {}

function actionOf(id: string): ActionSpec {
  const action = ALL_ACTIONS.find((candidate) => candidate.id === id)
  if (action === undefined) throw new Error(`no action ${id} in the three sections`)
  return action
}

describe('every action builds a command line the CLI would accept', () => {
  const cases: ReadonlyArray<readonly [string, FormValues, readonly string[]]> = [
    ['list', BLANK, ['approvals', 'list']],
    [
      'approve',
      FILLED,
      ['approvals', 'approve', FILLED.id ?? '', '--reason', FILLED.reason ?? ''],
    ],
    ['deny', FILLED, ['approvals', 'deny', FILLED.id ?? '', '--reason', FILLED.reason ?? '']],
    ['sessions', BLANK, ['sessions']],
    [
      'show',
      FILLED,
      [
        'show',
        'plane_probe',
        '--method',
        'tools/call',
        '--direction',
        'client→server',
        '--kind',
        'request',
        '--json',
      ],
    ],
    ['export', FILLED, ['export', '--session', 'plane_probe']],
    [
      'export-report',
      FILLED,
      ['export', '--report', '--session', 'plane_probe', '--out', '/tmp/mcp-out'],
    ],
    ['verify', FILLED, ['verify', '--session', 'plane_probe']],
    ['verify-sign', FILLED, ['verify', '--sign', '--session', 'plane_probe']],
    [
      'verify-report',
      FILLED,
      ['verify', '--report', '/tmp/report', '--pub', '/tmp/signing.pub', '--require-signature'],
    ],
    ['keygen', BLANK, ['keygen']],
    ['backup', FILLED, ['backup', '/tmp/backup']],
    ['prune', FILLED, ['prune', '--older-than', '90d', '--yes']],
    ['migrate', BLANK, ['migrate']],
  ]

  test.each(cases)('%s builds its documented argv', (id, values, expected) => {
    // Arrange
    const action = actionOf(id)

    // Act
    const argv = action.argv(values)

    // Assert
    expect(argv).toEqual(expected)
  })

  test('argv returns a fresh array on every call: nothing shares a command line', () => {
    for (const action of ALL_ACTIONS) {
      const first = action.argv(FILLED)
      const second = action.argv(FILLED)

      expect(second, `argv of ${action.id}`).not.toBe(first)
      expect(second, `argv of ${action.id}`).toEqual(first)
    }
  })
})

describe('an optional field left empty leaves its flag out', () => {
  const cases: ReadonlyArray<readonly [string, FormValues, readonly string[]]> = [
    ['approve', REQUIRED_ONLY, ['approvals', 'approve', REQUIRED_ONLY.id ?? '']],
    ['deny', REQUIRED_ONLY, ['approvals', 'deny', REQUIRED_ONLY.id ?? '']],
    ['show', REQUIRED_ONLY, ['show', 'plane_probe']],
    ['export', BLANK, ['export']],
    ['export-report', BLANK, ['export', '--report']],
    ['verify', BLANK, ['verify']],
    ['verify-sign', BLANK, ['verify', '--sign']],
    ['verify-report', REQUIRED_ONLY, ['verify', '--report', '/tmp/report']],
    ['prune', REQUIRED_ONLY, ['prune', '--older-than', '90d']],
  ]

  test.each(cases)('%s omits what was not filled in', (id, values, expected) => {
    // Arrange
    const action = actionOf(id)

    // Act
    const argv = action.argv(values)

    // Assert
    expect(argv).toEqual(expected)
  })

  test('a choice left at its "any" option asks the journal for everything', () => {
    // Arrange
    const show = actionOf('show')
    const anyDirection = show.fields.find((field) => field.name === 'direction')
    const anyKind = show.fields.find((field) => field.name === 'kind')

    // Act
    const argv = show.argv({ session: 'plane_probe', direction: 'any', kind: 'any' })

    // Assert
    expect(argv).toEqual(['show', 'plane_probe'])
    expect(anyDirection?.options).toEqual(['any', ...JOURNAL_DIRECTIONS])
    expect(anyKind?.options).toEqual(['any', ...JOURNAL_KINDS])
  })
})

describe('export hands its records to a file rather than to the pane', () => {
  test('the path travels as stdoutToField and never as an argument', () => {
    // Arrange
    const exportAction = actionOf('export')

    // Act
    const argv = exportAction.argv(FILLED)

    // Assert
    expect(exportAction.stdoutToField).toBe('out')
    expect(argv).not.toContain('/tmp/mcp-out')
    expect(argv).not.toContain('--out')
  })

  test('the output path is required: an export with nowhere to go never runs', () => {
    // Arrange
    const exportAction = actionOf('export')

    // Act
    const out = exportAction.fields.find((field) => field.name === 'out')

    // Assert
    expect(out?.required).toBe(true)
    expect(out?.hint).toBe(EXPORT_OUT_HINT)
  })

  test('no other action writes its stdout to a file', () => {
    const withStdout = ALL_ACTIONS.filter((action) => action.stdoutToField !== undefined)

    expect(withStdout.map((action) => action.id)).toEqual(['export'])
  })
})

describe('prune asks before it deletes, and only when it would delete', () => {
  test('a dry run is not a question: confirm is undefined without --yes', () => {
    // Arrange
    const prune = actionOf('prune')

    // Act
    const question = prune.confirm?.({ 'older-than': '90d' })

    // Assert
    expect(question).toBeUndefined()
  })

  test('with --yes the question names the period the operator typed', () => {
    // Arrange
    const prune = actionOf('prune')

    // Act
    const question = prune.confirm?.({ 'older-than': '36h', yes: 'true' })

    // Assert
    expect(question).toContain('36h')
  })

  test('the period field accepts what parseRetentionDuration accepts and nothing else', () => {
    // Arrange
    const prune = actionOf('prune')
    const olderThan = prune.fields.find((field) => field.name === 'older-than')

    // Act & Assert
    expect(olderThan?.validate?.('90d')).toBeUndefined()
    expect(olderThan?.validate?.('36h')).toBeUndefined()
    expect(olderThan?.validate?.('90')).toBeDefined()
    expect(olderThan?.validate?.('1w')).toBeDefined()
    // The two the shape alone lets through and the command still refuses: a
    // period of nothing, and one longer than `MAX_RETENTION_DAYS`.
    expect(olderThan?.validate?.('0d')).toBeDefined()
    expect(olderThan?.validate?.('99999d')).toBeDefined()
  })

  test('the field and the command give the same verdict on every one of them', () => {
    const olderThan = actionOf('prune').fields.find((field) => field.name === 'older-than')

    for (const period of ['90d', '36h', '0d', '0h', '99999d', '1w', '90', '', 'd']) {
      const accepted = olderThan?.validate?.(period) === undefined
      expect(accepted, `the form and prune disagree about "${period}"`).toBe(
        parseRetentionDuration(period) !== null,
      )
    }
  })

  test('no other action of these sections asks a question', () => {
    const asking = ALL_ACTIONS.filter((action) => action.confirm !== undefined)

    expect(asking.map((action) => action.id)).toEqual(['prune'])
  })
})

describe('the session field of show is the id the journal itself validates', () => {
  test('it refuses what SESSION_ID_PATTERN refuses', () => {
    // Arrange
    const session = actionOf('show').fields.find((field) => field.name === 'session')

    // Act & Assert
    expect(session?.required).toBe(true)
    expect(session?.validate?.('plane_probe')).toBeUndefined()
    expect(session?.validate?.('has space')).toBeDefined()
    expect(SESSION_ID_PATTERN.test('plane_probe')).toBe(true)
  })
})

describe('role thresholds keep a screen free of dead ends', () => {
  function idsFor(section: SectionSpec, role: Role): readonly string[] {
    return visibleActions(section, role).map((action) => action.id)
  }

  test('a viewer reads the queue, the journal and the evidence, and changes nothing', () => {
    expect(idsFor(APPROVALS_SECTION, 'viewer')).toEqual(['list'])
    expect(idsFor(JOURNAL_SECTION, 'viewer')).toEqual(['sessions', 'show', 'export'])
    expect(idsFor(AUDIT_SECTION, 'viewer')).toEqual(['export-report', 'verify', 'verify-report'])
  })

  test('an operator additionally resolves requests', () => {
    expect(idsFor(APPROVALS_SECTION, 'operator')).toEqual(['list', 'approve', 'deny'])
    expect(idsFor(JOURNAL_SECTION, 'operator')).toEqual(['sessions', 'show', 'export'])
    expect(idsFor(AUDIT_SECTION, 'operator')).toEqual(['export-report', 'verify', 'verify-report'])
  })

  test('an owner signs, keys, copies and prunes', () => {
    expect(idsFor(AUDIT_SECTION, 'owner')).toEqual([
      'export-report',
      'verify',
      'verify-sign',
      'verify-report',
      'keygen',
      'backup',
      'prune',
      'migrate',
    ])
  })

  test('every section is readable by a viewer', () => {
    for (const section of SECTIONS) {
      expect(section.minRole, `minRole of ${section.id}`).toBe('viewer')
    }
  })
})

describe('the r key re-reads what a section can re-read', () => {
  test('Approvals refreshes its queue and Journal its session list', () => {
    expect(APPROVALS_SECTION.refreshActionId).toBe('list')
    expect(JOURNAL_SECTION.refreshActionId).toBe('sessions')
  })

  test('Audit has no refresh: none of its actions merely reads state', () => {
    expect(AUDIT_SECTION.refreshActionId).toBeUndefined()
  })

  test('a refresh action exists and needs no form', () => {
    for (const section of [APPROVALS_SECTION, JOURNAL_SECTION]) {
      const refresh = section.actions.find((action) => action.id === section.refreshActionId)

      expect(refresh, `refresh action of ${section.id}`).toBeDefined()
      expect(refresh?.fields, `fields of ${section.id} refresh`).toEqual([])
    }
  })
})

describe('the three sections fit the screen they are drawn on', () => {
  test('every action title fits the action column beside its marker', () => {
    for (const action of ALL_ACTIONS) {
      expect(action.title.length, `title of ${action.id}`).toBeLessThanOrEqual(TITLE_MAX_WIDTH)
    }
  })

  test('every intro and action hint fits one line of the pane', () => {
    for (const section of SECTIONS) {
      for (const line of section.intro) {
        expect(line.length, `intro of ${section.id}`).toBeLessThanOrEqual(LINE_MAX_CHARS)
      }
    }
    for (const action of ALL_ACTIONS) {
      expect((action.hint ?? '').length, `hint of ${action.id}`).toBeLessThanOrEqual(LINE_MAX_CHARS)
    }
  })

  test('every field hint fits beside the value it describes', () => {
    for (const action of ALL_ACTIONS) {
      for (const field of action.fields) {
        // No exception for the shared `EXPORT_OUT_HINT` any more: it was
        // shortened to fit the same line every hint a section writes fits.
        expect((field.hint ?? '').length, `hint of ${field.name}`).toBeLessThanOrEqual(
          FIELD_HINT_MAX_CHARS,
        )
      }
    }
  })
})
