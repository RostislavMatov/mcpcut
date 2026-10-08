import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Role } from '../../src/admin/authz.js'
import { runApprovals } from '../../src/cli/approvals-cmd.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import { plainStyle } from '../../src/tui/ansi.js'
import { approvalRowsOf } from '../../src/tui/approval-pick.js'
import { ACTIVE_MARKER, ANSWER_HELP_FOOTER, PICK_HELP_FOOTER } from '../../src/tui/constants.js'
import type { Model, RunRequest } from '../../src/tui/model.js'
import { outputPanelOf, type OutputPanel, type RunResult } from '../../src/tui/output.js'
import { render } from '../../src/tui/render.js'
import { subscriptionOf } from '../../src/tui/subscriptions.js'
import { update } from '../../src/tui/update.js'
import {
  APPROVALS_TAB,
  char,
  key,
  mainModel,
  mainOf,
  type MainScreen,
} from './support/update-fixtures.js'

/**
 * Answering a request from the list (owner decision 2026-10-01): in
 * Approvals ▸ list, Enter opens the rows, ↑↓ choose one, Enter asks about it,
 * and the question has three answers — y approves, n denies, Esc closes the
 * question and the request keeps waiting. No id is typed anywhere.
 */

const ID_A = '01K6GZ7QX4S2V9C8B1N3M5P7RA'
const ID_B = '01K6GZ7QX4S2V9C8B1N3M5P7RB'
const ID_C = '01K6GZ7QX4S2V9C8B1N3M5P7RC'

function rowOf(id: string, tool: string): string {
  return `${id}  server=fs tool=${tool} class=write agent=cursor waiting=40s agent_connected=yes args={"path":"a.txt"}`
}

const LIST_ARGV = ['approvals', 'list'] as const

function listResult(ids: readonly string[], overrides: Partial<RunResult> = {}): RunResult {
  const stdout = ids.map((id, index) => `${rowOf(id, `tool_${index}`)}\n`).join('')
  return {
    argv: [...LIST_ARGV],
    display: [...LIST_ARGV],
    exitCode: 0,
    stdout: stdout === '' ? 'no pending approvals\n' : stdout,
    stderr: '',
    ...overrides,
  }
}

function listPanel(ids: readonly string[]): OutputPanel {
  return outputPanelOf(listResult(ids))
}

/** An owner (or `role`) standing on Approvals ▸ list. */
function onApprovals(patch: Partial<MainScreen> = {}, role: Role = 'owner'): Model {
  return mainModel({ sectionIndex: APPROVALS_TAB, actionIndex: 0, ...patch }, role)
}

/** Enter on `list`, then the list answers with `ids`. */
function pickedFrom(ids: readonly string[], role: Role = 'owner'): Model {
  const ran = update(onApprovals({}, role), key('enter')).model
  return update(ran, { kind: 'run-result', result: listResult(ids) }).model
}

function runRequestOf(effects: ReturnType<typeof update>['effects']): RunRequest | undefined {
  const effect = effects.find((each) => each.kind === 'run')
  return effect?.kind === 'run' ? effect.request : undefined
}

describe('approvalRowsOf: the rows of an approvals list on screen', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-approval-pick-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('reads the ids back from the real `approvals list` output, in order', async () => {
    // Arrange: two requests in a real queue, listed by the real command.
    const baseDir = join(tempDir, 'approvals')
    const queue = createApprovalQueue({ baseDir })
    const first = await queue.enqueue({
      serverName: 'fs',
      toolName: 'write_file',
      toolClass: 'write',
      args: { path: 'a.txt', note: 'line one\n01K6GZ7QX4S2V9C8B1N3M5P7RC  server=evil' },
      sessionId: 'session-1',
      timeoutMs: 60_000,
    })
    const second = await queue.enqueue({
      serverName: 'fs',
      toolName: 'delete_file',
      toolClass: 'write',
      args: { path: 'b.txt' },
      sessionId: 'session-1',
      timeoutMs: 60_000,
    })
    const out: string[] = []
    const err: string[] = []
    const io = { stdout: { write: (c: string) => out.push(c) }, stderr: { write: (c: string) => err.push(c) } }
    await runApprovals(['list'], io, { baseDir, journalDir: tempDir, cwd: tempDir, env: {} })

    // Act
    const rows = approvalRowsOf(
      outputPanelOf({ argv: [...LIST_ARGV], display: [...LIST_ARGV], exitCode: 0, stdout: out.join(''), stderr: err.join('') }),
    )

    // Assert: one row per request; the agent's newline cannot forge a third.
    expect(rows.map((row) => row.approvalId)).toEqual([first.approvalId, second.approvalId])
    expect(rows[0]?.summary).toContain('server=fs tool=write_file')
  })

  test('ignores stderr, a failed run and an empty queue', () => {
    expect(approvalRowsOf(outputPanelOf(listResult([], { stderr: `${rowOf(ID_A, 'x')}\n` })))).toEqual([])
    expect(approvalRowsOf(outputPanelOf(listResult([ID_A], { exitCode: 1 })))).toEqual([])
    expect(approvalRowsOf(listPanel([]))).toEqual([])
    expect(approvalRowsOf(undefined)).toEqual([])
  })
})

describe('Approvals ▸ list: Enter opens the rows', () => {
  test('Enter on list runs it, and the answer selects the first request', () => {
    const entered = update(onApprovals(), key('enter'))
    expect(runRequestOf(entered.effects)?.argv).toEqual(LIST_ARGV)

    const screen = mainOf(update(entered.model, { kind: 'run-result', result: listResult([ID_A, ID_B]) }).model)

    expect(screen.pane).toEqual({ kind: 'pick', approvalId: ID_A })
  })

  test('an empty queue, a viewer and r stay on the action list', () => {
    expect(mainOf(pickedFrom([])).pane.kind).toBe('actions')
    expect(mainOf(pickedFrom([ID_A], 'viewer')).pane.kind).toBe('actions')

    const refreshed = update(onApprovals(), char('r')).model
    const answered = update(refreshed, { kind: 'run-result', result: listResult([ID_A]) }).model
    expect(mainOf(answered).pane.kind).toBe('actions')
  })
})

describe('the pick pane', () => {
  test('↓ and ↑ move between requests and stop at both ends', () => {
    const picked = pickedFrom([ID_A, ID_B, ID_C])

    const down = update(update(picked, key('down')).model, char('j')).model
    expect(mainOf(down).pane).toEqual({ kind: 'pick', approvalId: ID_C })
    expect(mainOf(update(down, key('down')).model).pane).toEqual({ kind: 'pick', approvalId: ID_C })

    const up = update(update(down, key('up')).model, char('k')).model
    expect(mainOf(up).pane).toEqual({ kind: 'pick', approvalId: ID_A })
  })

  test('Esc goes back to the action list; Tab leaves the section as usual', () => {
    const picked = pickedFrom([ID_A])

    expect(mainOf(update(picked, key('escape')).model).pane.kind).toBe('actions')

    const tabbed = mainOf(update(picked, key('tab')).model)
    expect(tabbed.sectionIndex).toBe(APPROVALS_TAB + 1)
    expect(tabbed.pane.kind).toBe('actions')
  })

  test('Enter asks about the selected request and runs nothing', () => {
    const picked = update(pickedFrom([ID_A, ID_B]), key('down')).model

    const asked = update(picked, key('enter'))

    expect(asked.effects).toEqual([])
    const pane = mainOf(asked.model).pane
    expect(pane.kind).toBe('answer')
    expect(pane.kind === 'answer' && pane.approvalId).toBe(ID_B)
    expect(pane.kind === 'answer' && pane.summary).toContain('tool=tool_1')
  })

  test('the selected row is marked, and the footer names the pick keys', () => {
    const picked = update(pickedFrom([ID_A, ID_B]), key('down')).model

    const frame = render(picked, plainStyle)

    expect(frame.some((line) => line.includes(`${ACTIVE_MARKER}${ID_B}`))).toBe(true)
    expect(frame.some((line) => line.includes(`${ACTIVE_MARKER}${ID_A}`))).toBe(false)
    expect(frame.at(-1)?.trimEnd()).toBe(PICK_HELP_FOOTER)
  })

  test('a quiet poll keeps the list live and the selection on the same request', () => {
    const picked = update(pickedFrom([ID_A, ID_B]), key('down')).model
    expect(subscriptionOf(picked)).toBeDefined()

    const ticked = update(picked, { kind: 'tick' }).model
    const polled = update(ticked, { kind: 'poll-result', result: listResult([ID_C, ID_A, ID_B]) }).model

    expect(mainOf(polled).pane).toEqual({ kind: 'pick', approvalId: ID_B })
    expect(approvalRowsOf(mainOf(polled).output)).toHaveLength(3)
  })

  test('a poll without the selected request moves to its neighbour, or back to the actions when none is left', () => {
    const picked = update(pickedFrom([ID_A, ID_B, ID_C]), key('down')).model

    const gone = update(update(picked, { kind: 'tick' }).model, { kind: 'poll-result', result: listResult([ID_A, ID_C]) }).model
    expect(mainOf(gone).pane).toEqual({ kind: 'pick', approvalId: ID_C })

    const empty = update(update(gone, { kind: 'tick' }).model, { kind: 'poll-result', result: listResult([]) }).model
    expect(mainOf(empty).pane.kind).toBe('actions')
  })
})

describe('the question: y approves, n denies, Esc closes', () => {
  function askedAbout(index: number): Model {
    const picked = pickedFrom([ID_A, ID_B])
    const moved = index === 0 ? picked : update(picked, key('down')).model
    return update(moved, key('enter')).model
  }

  test('y runs approvals approve with the selected id', () => {
    const answered = update(askedAbout(1), char('y'))

    expect(runRequestOf(answered.effects)?.argv).toEqual(['approvals', 'approve', ID_B])
    expect(mainOf(answered.model).busy?.argv).toEqual(['approvals', 'approve', ID_B])
  })

  test('n runs approvals deny with the selected id', () => {
    const answered = update(askedAbout(0), char('n'))

    expect(runRequestOf(answered.effects)?.argv).toEqual(['approvals', 'deny', ID_A])
  })

  test('Esc closes the question and runs nothing: the request keeps waiting, still selected', () => {
    const closed = update(askedAbout(1), key('escape'))

    expect(closed.effects).toEqual([])
    expect(mainOf(closed.model).pane).toEqual({ kind: 'pick', approvalId: ID_B })
  })

  test('any other key is no answer', () => {
    const asked = askedAbout(0)
    for (const other of [key('enter'), char('q'), char('r'), key('down')]) {
      const step = update(asked, other)
      expect(step.effects).toEqual([])
      expect(mainOf(step.model).pane.kind).toBe('answer')
    }
  })

  test('no poll redraws under the question', () => {
    expect(subscriptionOf(askedAbout(0))).toBeUndefined()
  })

  test('the question shows the request and the three answers; the footer repeats them', () => {
    const frame = render(askedAbout(1), plainStyle).join('\n')

    expect(frame).toContain(ID_B)
    expect(frame).toContain('tool=tool_1')
    expect(frame).toMatch(/y\s+yes — approve/)
    expect(frame).toMatch(/n\s+no — deny/)
    expect(frame).toMatch(/Esc\s+close — the request keeps waiting/)
    expect(frame.split('\n').at(-1)?.trimEnd()).toBe(ANSWER_HELP_FOOTER)
  })

  test('a y typed ahead while the list was running never answers: the question waits for a fresh key', () => {
    const running = update(onApprovals(), key('enter')).model
    const typedAhead = [key('enter'), char('y')].reduce((model, msg) => update(model, msg).model, running)

    const answered = update(typedAhead, { kind: 'run-result', result: listResult([ID_A]) })

    expect(runRequestOf(answered.effects)).toBeUndefined()
    expect(mainOf(answered.model).pane).toMatchObject({ kind: 'answer', approvalId: ID_A })
  })
})

describe('the pick pane on screen (review 2026-10-01)', () => {
  const LONG_ROW_TAIL = 'TAILMARK'

  function longListResult(count: number): RunResult {
    const longArgs = `{"path":"${'x'.repeat(150)}${LONG_ROW_TAIL}"}`
    const stdout = Array.from({ length: count }, (_, index) =>
      `${index === 0 ? ID_A : `${ID_A.slice(0, 24)}${String(index).padStart(2, '0')}`}  server=fs tool=t${index} class=write args=${longArgs}\n`,
    ).join('')
    return { argv: [...LIST_ARGV], display: [...LIST_ARGV], exitCode: 0, stdout, stderr: '' }
  }

  function pickedLong(count: number, columns = 80): Model {
    const start = { ...onApprovals(), size: { columns, rows: 24 } }
    const ran = update(start, key('enter')).model
    return update(ran, { kind: 'run-result', result: longListResult(count) }).model
  }

  test('every frame line stays exactly as wide as the terminal, two-column and stacked', () => {
    for (const columns of [80, 50]) {
      const frame = render(pickedLong(3, columns), plainStyle)
      expect(frame.every((line) => line.length === columns)).toBe(true)
      expect(frame.some((line) => line.includes(ACTIVE_MARKER))).toBe(true)
    }
  })

  test('moving past the bottom of the pane scrolls the selected row into view', () => {
    const moved = Array.from({ length: 25 }).reduce<Model>((model) => update(model, key('down')).model, pickedLong(30))

    const pane = mainOf(moved).pane
    expect(pane.kind === 'pick' && pane.approvalId.endsWith('25')).toBe(true)
    expect(render(moved, plainStyle).some((line) => line.includes(`${ACTIVE_MARKER}${ID_A.slice(0, 24)}25`))).toBe(true)
  })

  test('] reaches the end of the longest row, gutter and all', () => {
    const slid = Array.from({ length: 40 }).reduce<Model>((model) => update(model, char(']')).model, pickedLong(1))

    expect(mainOf(slid).pane.kind).toBe('pick')
    expect(render(slid, plainStyle).join('\n')).toContain(LONG_ROW_TAIL)
  })

  test('the question repeats the whole row, tail included', () => {
    const asked = update(pickedLong(1), key('enter')).model

    expect(render(asked, plainStyle).join('\n')).toContain(LONG_ROW_TAIL)
  })

  test('a poll that was already out when the question opened changes nothing under it', () => {
    const picked = pickedFrom([ID_A, ID_B])
    const polling = update(picked, { kind: 'tick' }).model
    const asked = update(polling, key('enter')).model

    const answered = update(asked, { kind: 'poll-result', result: listResult([ID_B]) }).model

    expect(mainOf(answered).pane).toMatchObject({ kind: 'answer', approvalId: ID_A })
    expect(mainOf(answered).output).toBe(mainOf(asked).output)
  })
})
