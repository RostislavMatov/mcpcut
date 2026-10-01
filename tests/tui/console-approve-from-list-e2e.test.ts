import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { createApprovalQueue, type ApprovalQueue } from '../../src/policy/approvals/queue.js'
import { ACTIVE_MARKER, ANSWER_HELP_FOOTER, PICK_HELP_FOOTER } from '../../src/tui/constants.js'
import { ANSWER_QUESTION } from '../../src/tui/render-pick.js'
import {
  closeConsoles,
  ENTER,
  goToSection,
  NO_KEY,
  openConsole,
  screenLines,
  signIn,
  waitForText,
  YES_KEY,
  type RunningConsole,
} from './support/console-harness.js'
import { waitForScreen } from './support/fake-terminal.js'

/**
 * The owner's design of 2026-10-01, end to end on the real reducer, the real
 * runtime and the real queue: in Approvals ▸ list, Enter opens the rows, ↓
 * chooses one, Enter asks, and y / n / Esc answer — no id is typed.
 */

const ESCAPE = '\x1b'
const DOWN_ARROW = '\x1b[B'
const OWNER_NAME = 'root'
const E2E_TIMEOUT_MS = 20_000
const WAIT_MS = 120_000

let journalDir: string
let store: AdminStore
let queue: ApprovalQueue

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-approve-from-list-'))
  store = createAdminStore({ journalDir })
  queue = createApprovalQueue({ baseDir: join(journalDir, 'approvals') })
})

afterEach(async () => {
  await closeConsoles()
  await rm(journalDir, { recursive: true, force: true })
})

async function seed(toolName: string): Promise<string> {
  const { approvalId } = await queue.enqueue({
    serverName: 'fs',
    toolName,
    toolClass: 'write',
    args: { path: `${toolName}.txt` },
    sessionId: 'session-1',
    timeoutMs: WAIT_MS,
  })
  return approvalId
}

/** An owner on Approvals with the rows open: Enter on `list`, the first request selected. */
async function rowsOpen(): Promise<RunningConsole> {
  const { token } = await store.createAdmin(OWNER_NAME, 'owner')
  const app = openConsole(journalDir)
  await signIn(app, token, OWNER_NAME, 'owner')
  await goToSection(app, 'approvals', 'owner')
  app.fake.type(ENTER)
  await waitForText(app, PICK_HELP_FOOTER, 'the rows to open')
  return app
}

async function askAboutSecond(app: RunningConsole, secondId: string): Promise<void> {
  app.fake.type(DOWN_ARROW)
  await waitForScreen(app.fake, (screen) => screen.includes(`${ACTIVE_MARKER}${secondId.slice(0, 20)}`), 'the second row')
  app.fake.type(ENTER)
  await waitForText(app, ANSWER_QUESTION, 'the question')
}

describe('console end to end: answering a request from the list', () => {
  test(
    'y approves the chosen request and leaves the other one waiting',
    async () => {
      const first = await seed('write_file')
      const second = await seed('delete_file')
      const app = await rowsOpen()

      await askAboutSecond(app, second)
      expect(app.fake.screen()).toContain(second)
      expect(app.fake.screen()).toContain('tool=delete_file')
      expect((screenLines(app.fake).at(-1) ?? '').trimEnd()).toBe(ANSWER_HELP_FOOTER)

      app.fake.type(YES_KEY)
      await waitForText(app, `Approved ${second}`, 'the approve run to answer')

      expect(app.argvCalls()).toContainEqual(['approvals', 'approve', second])
      expect((await queue.readResolution(second))?.outcome).toBe('approved')
      expect(await queue.readResolution(first)).toBeNull()
    },
    E2E_TIMEOUT_MS,
  )

  test(
    'n denies the chosen request',
    async () => {
      const first = await seed('write_file')
      const app = await rowsOpen()

      app.fake.type(ENTER)
      await waitForText(app, ANSWER_QUESTION, 'the question')
      app.fake.type(NO_KEY)
      await waitForText(app, `Denied ${first}`, 'the deny run to answer')

      expect((await queue.readResolution(first))?.outcome).toBe('denied')
    },
    E2E_TIMEOUT_MS,
  )

  test(
    'Esc closes the question: nothing runs and the request keeps waiting',
    async () => {
      const first = await seed('write_file')
      const app = await rowsOpen()
      app.fake.type(ENTER)
      await waitForText(app, ANSWER_QUESTION, 'the question')
      const callsWhenAsked = app.argvCalls().length

      app.fake.type(ESCAPE)
      await waitForText(app, PICK_HELP_FOOTER, 'back on the rows')

      expect(app.argvCalls().length).toBe(callsWhenAsked)
      expect(await queue.readResolution(first)).toBeNull()
    },
    E2E_TIMEOUT_MS,
  )
})
