import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_PREFIX } from '../../src/admin/constants.js'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import { EXIT_OK, QUIT_WITH_TOKEN_QUESTION } from '../../src/tui/constants.js'
import { APPROVALS_POLL_INTERVAL_MS } from '../../src/tui/constants-live.js'
import { CLIPPED_HELP_FOOTER } from '../../src/tui/render-main.js'
import {
  closeConsoles,
  ENTER,
  goToSection,
  NO_KEY,
  openConsole,
  QUIT_KEY,
  REFRESH_KEY,
  RIGHT_ARROW,
  RUN_TIMEOUT_MS,
  runAction,
  screenLines,
  signIn,
  TAB,
  TOKEN_HOLD_BANNER_HEAD,
  waitForText,
  YES_KEY,
  type RunningConsole,
} from './support/console-harness.js'
import { waitForScreen } from './support/fake-terminal.js'

/**
 * The two things phase 5 added that only show themselves over real time
 * (mcpcut phase 5, Task 9): the Approvals tab that re-reads its own queue,
 * and the one-time token the console refuses to lose.
 *
 * Both are end-to-end because both are agreements between layers. The live
 * queue is a subscription derived from the model, a timer in the runtime, a
 * quiet effect through the REAL `approvals list`, and a reducer that folds
 * the answer back without disturbing what the operator is reading — a unit
 * test of any one of them would pass while the operator still stared at a
 * stale pane. The token hold is a pane, a footer, four ignored keys and a
 * quit question, and the only assertion worth making about it is that the
 * token was still on screen after the keys that used to erase it.
 *
 * The waiting here is real: the first quiet poll is a whole
 * `APPROVALS_POLL_INTERVAL_MS` away, and there is no seam for it on purpose —
 * the interval is catalogue DATA, not a dependency, so a suite that shortened
 * it would be testing a console nobody runs.
 */

/** The tail of `QUIT_WITH_TOKEN_QUESTION`, which survives the pane's wrapping. */
const QUIT_QUESTION_TAIL = 'Quit anyway? [y/N]'

/** How long a wait spanning one quiet poll may take: the poll, then its command. */
const POLL_WAIT_TIMEOUT_MS = APPROVALS_POLL_INTERVAL_MS + RUN_TIMEOUT_MS

/** Whole-test budget for the live test: it spends two poll intervals waiting. */
const LIVE_TEST_TIMEOUT_MS = 20_000

/** Slack on top of one interval, for the absence assertion at the end. */
const MISSED_TICK_SLACK_MS = 500

/** The owner every test signs in as, and the admin one of them creates. */
const OWNER_NAME = 'root'
const NEW_ADMIN_NAME = 'alice'
const NEW_ADMIN_ROLE = 'operator'

/** The request seeded straight into the queue, as `approvals-cmd.test.ts` shapes one. */
const SEEDED_SERVER = 'github'
const SEEDED_TOOL = 'create_issue'
const SEEDED_TIMEOUT_MS = 60_000

/**
 * The row that request draws, as far as the pane shows it. A queue row is
 * `<ulid>  server=… tool=…` and the pane is 54 columns wide, so the tool name
 * runs off the right edge — the same reason `ActionRun.command` is a prefix.
 */
const SEEDED_ROW = `server=${SEEDED_SERVER}`
const SEEDED_TOOL_HEAD = `tool=${SEEDED_TOOL.split('_')[0] ?? ''}`

let journalDir: string
let store: AdminStore

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-live-e2e-'))
  store = createAdminStore({ journalDir })
})

afterEach(async () => {
  await closeConsoles()
  await rm(journalDir, { recursive: true, force: true })
})

/** Signs a fresh owner into a fresh console over the temp journal directory. */
async function ownerConsole(): Promise<RunningConsole> {
  const { token } = await store.createAdmin(OWNER_NAME, 'owner')
  const app = openConsole(journalDir)
  await signIn(app, token, OWNER_NAME, 'owner')
  return app
}

/** The footer line of the current frame — the last row the console drew. */
function footerOf(app: RunningConsole): string {
  return (screenLines(app.fake).at(-1) ?? '').trimEnd()
}

describe('console end to end: the Approvals queue re-reads itself', () => {
  test(
    'shows a request that arrived while nobody pressed a key, and stops when the tab is left',
    async () => {
      // Arrange: an owner standing on Approvals, having pressed nothing there.
      const app = await ownerConsole()
      const { fake } = app
      await goToSection(app, 'approvals', 'owner')

      // Act & Assert: the first quiet poll draws an empty queue on its own.
      await waitForText(app, 'no pending approvals', 'the first quiet poll', POLL_WAIT_TIMEOUT_MS)
      // Quiet means quiet: a tick must not put the run banner on the pane or
      // make the keyboard deaf the way `Enter` does (plan P1). No frame the
      // console has drawn since it opened may carry the running line.
      expect(fake.frames().every((frame) => !frame.includes('running: $'))).toBe(true)

      // A proxy enqueues while the operator watches — the same queue the
      // console's `approvals list` reads (the harness points both at
      // `<journalDir>/approvals`).
      await createApprovalQueue({ baseDir: join(journalDir, 'approvals') }).enqueue({
        serverName: SEEDED_SERVER,
        toolName: SEEDED_TOOL,
        toolClass: 'write',
        args: { title: 'hello' },
        sessionId: 'session-1',
        timeoutMs: SEEDED_TIMEOUT_MS,
      })

      await waitForText(app, SEEDED_ROW, 'the next quiet poll', POLL_WAIT_TIMEOUT_MS)
      expect(fake.screen()).toContain(SEEDED_TOOL_HEAD)

      // Leaving the tab takes the subscription with it: the timer belongs to
      // the section on screen, not to the console.
      fake.type(TAB)
      await waitForScreen(
        fake,
        (screen) => !screen.includes('approve'),
        'the section after Approvals',
      )
      const callsWhenLeft = app.argvCalls().length

      // The one sleep in these suites, and it is here because what is asserted
      // is an ABSENCE: no predicate over a frame can become true when the
      // point is that nothing happens. A full interval plus slack is the
      // window a tick would have fired in.
      const window = APPROVALS_POLL_INTERVAL_MS + MISSED_TICK_SLACK_MS
      await new Promise((resolve) => setTimeout(resolve, window))
      expect(app.argvCalls().length).toBe(callsWhenLeft)
    },
    LIVE_TEST_TIMEOUT_MS,
  )
})

describe('console end to end: a one-time token is held until it is saved', () => {
  test('ignores every key that would erase the token, and lets go on y', async () => {
    // Arrange: an owner who has just minted an admin token.
    const app = await ownerConsole()
    const { fake } = app
    await goToSection(app, 'admins', 'owner')
    await runAction(app, {
      title: 'add',
      values: [NEW_ADMIN_NAME, RIGHT_ARROW],
      command: `admin add ${NEW_ADMIN_NAME} --role ${NEW_ADMIN_ROLE}`,
    })

    await waitForText(app, TOKEN_HOLD_BANNER_HEAD, 'the token-hold banner')
    expect(fake.screen()).toContain(`token: ${ADMIN_TOKEN_PREFIX}`)

    const heldFrame = fake.screen()
    const callsWhenHeld = app.argvCalls().length

    // Act: the three keys that used to take the token away. None of them may
    // navigate, dispatch, or replace the panel (plan P2).
    fake.type(TAB)
    fake.type(REFRESH_KEY)
    fake.type(ENTER)

    // `q` is the one key that answers, so it is what proves the three above
    // were seen and dropped rather than merely still in flight.
    fake.type(QUIT_KEY)
    await waitForText(app, QUIT_QUESTION_TAIL, 'the quit confirmation')
    expect(fake.screen()).toContain(QUIT_WITH_TOKEN_QUESTION.split(' ').slice(0, 4).join(' '))

    // Assert: `n` returns to exactly the frame the ignored keys were pressed
    // on — same section, same panel, same token, banner and all.
    fake.type(NO_KEY)
    await waitForScreen(fake, (screen) => screen === heldFrame, 'the held token again')
    expect(app.argvCalls().length).toBe(callsWhenHeld)

    // Act: the operator says they copied it.
    fake.type(YES_KEY)
    await waitForScreen(
      fake,
      (screen) => !screen.includes(TOKEN_HOLD_BANNER_HEAD),
      'the banner to go',
    )

    // Assert: acknowledging does not erase the token — it only stops the
    // console from insisting. The footer is the CLIPPED one because a token
    // is longer than the pane is wide, not because anything is still held.
    expect(fake.screen()).toContain(`token: ${ADMIN_TOKEN_PREFIX}`)
    expect(footerOf(app)).toBe(CLIPPED_HELP_FOOTER)

    // And `q` now leaves without asking: the warning was about a token the
    // operator had not saved, and they have said they did.
    const framesBeforeQuit = fake.frames().length
    fake.type(QUIT_KEY)
    expect(await app.exit).toBe(EXIT_OK)
    expect(
      fake.frames().slice(framesBeforeQuit).every((frame) => !frame.includes(QUIT_QUESTION_TAIL)),
    ).toBe(true)
  })
})
