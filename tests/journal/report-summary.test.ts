import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { AS_OF_CONTRACT, buildJournalReport, type ReportRecordSink } from '../../src/journal/report.js'
import { MAX_SUMMARY_DECISION_ROWS } from '../../src/journal/report-summary.js'
import type { SqliteHandle } from '../../src/store/sqlite.js'

/**
 * `summary.md`, the human-readable half of the audit report (M5 wave 5,
 * tasks 5.1/5.2). Everything it prints is read back from the journal and is
 * therefore untrusted -- the terminal-escape and table-delimiter tests below
 * are the guarantee that it stays that way.
 */

const AS_OF = '2026-08-18T12:00:00.000Z'

/** A raw ESC byte, the head of an ANSI escape sequence -- never written literally into this file. */
const ESC = String.fromCharCode(0x1b)

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-report-summary-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

const nullSink: ReportRecordSink = { writeLine: () => undefined }

async function openHandle(): Promise<SqliteHandle> {
  return openJournalDbShared(journalDbPathFor(journalDir))
}

function rowOf(doc: string, overrides: Partial<JournalRecordRow> = {}): JournalRecordRow {
  return {
    sessionId: 'session-1',
    recordId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-18T00:00:00.000Z',
    direction: 'client→server',
    kind: 'decision',
    method: 'tools/call',
    doc,
    ...overrides,
  }
}

interface DecisionOverrides {
  readonly sessionId?: string
  readonly outcome?: string
  readonly actor?: string
  readonly toolName?: string
  readonly rule?: string
  readonly grantsHash?: string
  readonly withPolicyHash?: boolean
}

function decisionDoc(overrides: DecisionOverrides = {}): string {
  return JSON.stringify({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    ts: '2026-08-18T00:00:01.000Z',
    sessionId: overrides.sessionId ?? 'session-1',
    direction: 'client→server',
    kind: 'decision',
    method: 'tools/call',
    payload: null,
    decision: {
      outcome: overrides.outcome ?? 'approved',
      rule: overrides.rule ?? 'write-require-approval',
      serverName: 'files',
      toolName: overrides.toolName ?? 'files.write',
      toolClass: 'write',
      quarantineState: 'known',
      argsHash: 'a'.repeat(64),
      ...(overrides.actor === undefined ? {} : { actor: overrides.actor }),
      ...(overrides.grantsHash === undefined ? {} : { grantsHash: overrides.grantsHash }),
      ...(overrides.withPolicyHash === false ? {} : { policyHash: 'p'.repeat(64) }),
    },
  })
}

function insertChained(handle: SqliteHandle, rows: readonly JournalRecordRow[]): void {
  handle.transaction((db) => insertRecordRows(db, rows))
}

async function summaryFor(rows: readonly JournalRecordRow[], session?: string): Promise<string> {
  const handle = await openHandle()
  if (rows.length > 0) insertChained(handle, rows)
  const now = (): string => AS_OF
  const options = session === undefined ? { now } : { now, session }
  const report = await buildJournalReport(handle, options, nullSink)
  return report.summaryMarkdown
}

describe('summary.md', () => {
  test('prints the as-of contract verbatim', async () => {
    const summary = await summaryFor([])

    expect(summary).toContain(AS_OF_CONTRACT)
    expect(summary).toContain(AS_OF)
  })

  test('carries outcome, rule, tool, actor, policyHash, grantsHash and argsHash for each decision', async () => {
    const summary = await summaryFor([rowOf(decisionDoc({ actor: 'ui:alice', grantsHash: 'g'.repeat(64) }))])

    expect(summary).toContain('approved')
    expect(summary).toContain('write-require-approval')
    expect(summary).toContain('files.write')
    expect(summary).toContain('ui:alice')
    expect(summary).toContain('p'.repeat(64))
    expect(summary).toContain('g'.repeat(64))
    expect(summary).toContain('a'.repeat(64))
  })

  test('groups decision rows under their own session heading', async () => {
    const summary = await summaryFor([
      rowOf(decisionDoc({ sessionId: 'session-1' })),
      rowOf(decisionDoc({ sessionId: 'session-2' }), { sessionId: 'session-2' }),
    ])

    expect(summary).toContain('session-1')
    expect(summary).toContain('session-2')
    expect(summary.indexOf('session-1')).toBeLessThan(summary.indexOf('session-2'))
  })

  test('says so plainly when the export holds no decisions at all', async () => {
    const summary = await summaryFor([])

    expect(summary.toLowerCase()).toContain('no decision records')
  })

  test('strips terminal control characters out of fields read back from the journal', async () => {
    const summary = await summaryFor([rowOf(decisionDoc({ toolName: `files${ESC}[2Jwrite` }))])

    expect(summary).not.toContain(ESC)
    // `[` is markdown-escaped on top of the control-character replacement:
    // both passes run, in that order, and neither substitutes for the other.
    expect(summary).toContain('files?\\[2Jwrite')
  })

  test('escapes a table delimiter embedded in a journal value so a row cannot forge columns', async () => {
    const summary = await summaryFor([rowOf(decisionDoc({ rule: 'a|b' }))])

    expect(summary).toContain('a\\|b')
  })

  test('marks a decision with no policyHash as unprovenanced instead of printing an empty cell', async () => {
    const summary = await summaryFor([rowOf(decisionDoc({ withPolicyHash: false }))])

    expect(summary).toContain('unprovenanced')
  })

  test('names the genesis prevHash instead of rendering it as a blank gap', async () => {
    const summary = await summaryFor([rowOf(decisionDoc())])

    expect(summary).toContain('(genesis: the empty string)')
  })

  test('reports the outcome tally the manifest carries', async () => {
    const summary = await summaryFor([
      rowOf(decisionDoc({ outcome: 'allow' })),
      rowOf(decisionDoc({ outcome: 'deny' })),
    ])

    expect(summary).toContain('allow')
    expect(summary).toContain('deny')
  })

  test('caps the rendered rows and states how many were omitted rather than dropping them silently', async () => {
    const rows = Array.from({ length: MAX_SUMMARY_DECISION_ROWS + 3 }, () => rowOf(decisionDoc()))

    const summary = await summaryFor(rows)

    expect(summary).toMatch(/3 further decision record/)
  })
})

/**
 * Wave-5 review, MEDIUM: `summary.md` is handed to a third party and read in
 * a renderer (GitHub, VS Code, pandoc, a GRC portal), not in `cat`. Only the
 * table delimiter was escaped, so a hostile MCP server's tool name rendered
 * as live HTML and as a clickable link in the delivered document.
 */
describe('summary.md: markup channels in untrusted values (P7)', () => {
  test('renders a hostile tool name as text, not as live HTML or a link', async () => {
    const hostile = '<img src=x onerror=alert(1)> [click](javascript:alert(2))'

    const summary = await summaryFor([rowOf(decisionDoc({ toolName: hostile }))])

    const row = summary.split('\n').find((line) => line.includes('onerror')) ?? ''
    // No UNescaped markup character survives: an HTML tag cannot open and a
    // link cannot form, so the renderer shows the tool name as written.
    // (`|` is excluded: the row's own table delimiters are legitimately bare.)
    expect(row).not.toMatch(/(?<!\\)[<>[\]`]/)
    expect(row).toContain('\\<img')
    expect(row).toContain('\\[click\\]')
  })

  test('escapes the markup channels in an actor name too, not only in tool names', async () => {
    const summary = await summaryFor([
      rowOf(decisionDoc({ actor: 'ui:alice <b>admin</b> `whoami`' })),
    ])

    expect(summary).toContain('\\<b\\>')
    expect(summary).not.toMatch(/(?<!\\)<b>/)
    expect(summary).toContain('\\`whoami\\`')
  })

  test('escapes an outcome rendered outside the table, in the counts list', async () => {
    // `byOutcome` keys reach the prose section, not just table cells -- an
    // escape applied only to cells would leave this channel open.
    const summary = await summaryFor([rowOf(decisionDoc({ outcome: 'allow<script>' }))])

    expect(summary).toContain('allow\\<script\\>')
    expect(summary).not.toMatch(/(?<!\\)<script>/)
  })

  test('leaves the as-of contract itself unescaped -- it is this codebase own text', async () => {
    const summary = await summaryFor([])

    expect(summary).toContain(AS_OF_CONTRACT)
  })
})

describe('summary.md: fields the journal reader never validated (P2)', () => {
  test('renders an explicit marker for a decision with no argsHash instead of throwing', async () => {
    const doc = JSON.stringify({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      ts: '2026-08-18T00:00:01.000Z',
      sessionId: 'session-1',
      direction: 'client→server',
      kind: 'decision',
      method: 'tools/call',
      payload: null,
      decision: { outcome: 'allow', rule: 'read-allow', toolName: 'files.read' },
    })

    const summary = await summaryFor([rowOf(doc)])

    expect(summary).toContain('(absent)')
    expect(summary).toContain('files.read')
  })
})
