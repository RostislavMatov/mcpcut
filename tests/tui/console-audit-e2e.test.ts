import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { createInventory } from '../../src/policy/inventory.js'
import { STATE_DB_FILE_NAME } from '../../src/policy/store-backend.js'
import { ACTIVE_MARKER } from '../../src/tui/constants.js'
import {
  accessRecords,
  acknowledgeToken,
  actionTitlesIn,
  closeConsoles,
  goToSection,
  NO_KEY,
  openConsole,
  runAction,
  signIn,
  SPACE,
  submitAction,
  TAB,
  waitForText,
  type RunningConsole,
} from './support/console-harness.js'
import { waitForScreen } from './support/fake-terminal.js'

/**
 * The console end to end, part three (mcpcut phase 4, Task 11): the evidence
 * commands, and what each role is shown.
 *
 * The Audit section is where the console touches the things an auditor is
 * handed — the chain walk, the installation's signing key, a backup of both
 * databases — and the one command in the product that deletes evidence.
 * `prune` is the reason this file exists as an end-to-end test rather than a
 * unit one: whether the console asks before deleting depends on a form flag,
 * a conditional `confirm`, a reducer and a dispatcher agreeing, and the only
 * assertion worth making is that the argv with `--yes` in it was never
 * dispatched after the operator said no.
 *
 * The role tests state, as literal data, what an operator and a viewer are
 * shown. The lists are written out rather than derived from the catalogue: a
 * test that computed them with the same function the console renders them
 * with could not notice the console showing a viewer the `add` button.
 */

const OWNER_NAME = 'root'
const OPERATOR_NAME = 'op'
const VIEWER_NAME = 'watcher'

/** The agent created only so that the journal has a record to audit. */
const AGENT_NAME = 'bot'

/** The retention window `prune` is asked about; nothing here is that old. */
const RETENTION = '1d'

/** The question `prune --yes` asks, as `audit.ts` writes it. */
const PRUNE_QUESTION = 'Delete journal records older than'

/**
 * What an operator sees in each of their sections, in tab order: no Admins,
 * no Vault, no owner-only action anywhere. Written out on purpose — see the
 * module note above.
 */
const OPERATOR_SECTIONS: readonly (readonly string[])[] = [
  ['status'],
  ['list', 'show', 'refresh'],
  ['list'],
  ['list', 'show'],
  ['show', 'show --server', 'validate'],
  ['list', 'show', 'approve', 'approve --all', 'reject'],
  ['list', 'approve', 'deny'],
  ['sessions', 'show', 'export'],
  ['export --report', 'verify', 'verify --report'],
]

/** The tenth section an operator sees; it has no digit key, only `Tab`. */
const OPERATOR_SERVICES: readonly string[] = ['status', 'start', 'stop', 'logs']

let journalDir: string
let store: AdminStore

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-audit-e2e-'))
  store = createAdminStore({ journalDir })
})

afterEach(async () => {
  await closeConsoles()
  await rm(journalDir, { recursive: true, force: true })
})

/** Signs an admin of `role` into a fresh console over the temp directory. */
async function consoleAs(name: string, role: 'owner' | 'operator' | 'viewer'): Promise<RunningConsole> {
  const { token } = await store.createAdmin(name, role)
  const app = openConsole(journalDir)
  await signIn(app, token, name, role)
  return app
}

describe('console end to end: the audit section', () => {
  test('verifies, mints a key, backs up, and asks before it would delete', async () => {
    const app = await consoleAs(OWNER_NAME, 'owner')
    const { fake } = app

    // The evidence commands need a journal to work on, and creating an agent
    // is the cheapest record the console can leave: `journal.db` exists from
    // here on, which is what `verify` and `prune` refuse to run without.
    await goToSection(app, 'agents', 'owner')
    await runAction(app, {
      title: 'create',
      values: [AGENT_NAME],
      command: `agent create ${AGENT_NAME}`,
    })
    // The agent's one-time token holds the pane until it is acknowledged
    // (phase 5, plan P2); every key below is one the hold would swallow.
    await acknowledgeToken(app)

    await goToSection(app, 'audit', 'owner')
    await runAction(app, { title: 'verify', values: [], command: 'verify' })

    await runAction(app, { title: 'keygen', command: 'keygen' })
    expect(fake.screen()).toContain('Public key')

    const backupDir = join(journalDir, 'bak')
    await runAction(app, { title: 'backup', values: [backupDir], command: 'backup /' })
    expect(await readdir(backupDir)).toContain(STATE_DB_FILE_NAME)

    // A dry run deletes nothing, so it is not asked about: a console that
    // asked here would train the reflex that dismisses the real question.
    await runAction(app, {
      title: 'prune',
      values: [RETENTION],
      command: `prune --older-than ${RETENTION}`,
    })
    expect(fake.frames().every((frame) => !frame.includes(PRUNE_QUESTION))).toBe(true)

    // With the Delete flag on, the same form asks — and "no" means the argv
    // carrying `--yes` was never dispatched.
    await submitAction(app, {
      title: 'prune',
      values: [RETENTION, SPACE],
      command: `prune --older-than ${RETENTION} --yes`,
    })
    await waitForText(app, PRUNE_QUESTION, 'the prune confirmation')
    fake.type(NO_KEY)
    await waitForScreen(
      fake,
      (screen) => !screen.includes(PRUNE_QUESTION),
      'the confirmation to be gone',
    )

    expect(app.argvCalls().every((argv) => !argv.includes('--yes'))).toBe(true)
    expect(app.errText()).toBe('')
  })
})

describe('console end to end: what a role is shown', () => {
  test('an operator gets approvals and quarantine, and no vault', async () => {
    const app = await consoleAs(OPERATOR_NAME, 'operator')
    const { fake } = app

    for (const [index, expected] of OPERATOR_SECTIONS.entries()) {
      fake.type(String(index + 1))
      await waitForScreen(
        fake,
        (screen) => sameTitles(actionTitlesIn(screen), expected),
        `section ${index + 1} to hold ${expected.join(', ')}`,
      )
    }

    // Ten sections and no more: the digits above reach the first nine, one
    // `Tab` steps onto Services — the tenth, which has no digit key of its
    // own — and one more wraps round to the first.
    fake.type(TAB)
    await waitForScreen(
      fake,
      (screen) => sameTitles(actionTitlesIn(screen), OPERATOR_SERVICES),
      'the Services tab an operator may drive',
    )

    fake.type(TAB)
    await waitForScreen(
      fake,
      (screen) => sameTitles(actionTitlesIn(screen), OPERATOR_SECTIONS[0] ?? []),
      'the tab bar to wrap round to Home',
    )

    // Both queues an operator answers are reachable and offer the decision.
    await goToSection(app, 'approvals', 'operator')
    expect(actionTitlesIn(fake.screen())).toContain('approve')
    await goToSection(app, 'quarantine', 'operator')
    expect(actionTitlesIn(fake.screen())).toContain('approve')

    // Not a single command of the console's ran under a name it should not:
    // no vault action exists to be chosen in any of the nine.
    expect(app.argvCalls().every((argv) => argv[0] !== 'vault')).toBe(true)
  })

  test('a viewer sees Servers as reading only, with no add', async () => {
    const app = await consoleAs(VIEWER_NAME, 'viewer')
    const { fake } = app

    await goToSection(app, 'servers', 'viewer')
    expect(actionTitlesIn(fake.screen())).toEqual(['list', 'show'])
    // The cursor is on the first of them, so `Enter` could only ever open a
    // reading command.
    expect(fake.screen().includes(`${ACTIVE_MARKER}list`)).toBe(true)

    await runAction(app, { title: 'list', command: 'server list' })
    expect(app.argvCalls().every((argv) => argv[1] !== 'add')).toBe(true)
  })
})

/** Whether two title lists are the same, in the same order. */
function sameTitles(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((title, i) => title === expected[i])
}

/**
 * Owner decision Q17 (2026-09-08), end to end: a release approved FROM THE
 * CONSOLE is refused for a viewer, allowed for an operator, and recorded
 * under the name of whoever signed in — `via: 'cli'`, because the console
 * runs the CLI on their behalf.
 *
 * This is the scenario the decision exists for. The threshold and the record
 * are unit-tested in `tests/cli/quarantine-cmd-token.test.ts`; what only an
 * end-to-end test can show is that the console's own session token reaches
 * the `quarantine` seam at all — without that wiring the gate would turn every
 * console release into a refusal, and the section would be a dead end.
 */

/** The server and tools the console releases from quarantine. */
const QUARANTINED_SERVER = 'srv-a'
const QUARANTINED_TOOL = 'write_file'
const SECOND_TOOL = 'read_file'

/** Puts `tools` in quarantine for `QUARANTINED_SERVER`, in the console's own store. */
async function seedQuarantine(...tools: readonly string[]): Promise<void> {
  const storePath = join(journalDir, 'tool-inventory.json')
  await createInventory(QUARANTINED_SERVER, { storePath }).observeToolsList(
    tools.map((name) => ({ name, description: 'seeded for the console' })),
  )
}

/** The `quarantine.*` records the console left, in commit order. */
async function releaseRecords(): Promise<Array<Record<string, unknown>>> {
  const records = await accessRecords(journalDir)
  return records.filter((payload) => String(payload['action']).startsWith('quarantine.'))
}

describe('console end to end: releasing a tool from quarantine (Q17)', () => {
  test('an owner releases a tool and the record names them, via the CLI', async () => {
    await seedQuarantine(QUARANTINED_TOOL)
    const app = await consoleAs(OWNER_NAME, 'owner')

    await goToSection(app, 'quarantine', 'owner')
    await runAction(app, {
      title: 'approve',
      values: [QUARANTINED_SERVER, QUARANTINED_TOOL],
      command: `quarantine approve ${QUARANTINED_SERVER} ${QUARANTINED_TOOL}`,
    })

    expect(await releaseRecords()).toEqual([
      {
        actor: { adminName: OWNER_NAME, role: 'owner', via: 'cli' },
        action: 'quarantine.approve',
        server: QUARANTINED_SERVER,
        tool: QUARANTINED_TOOL,
      },
    ])
  })

  test('an operator releases one too: the threshold is theirs, not only an owner’s', async () => {
    await seedQuarantine(SECOND_TOOL)
    const app = await consoleAs(OPERATOR_NAME, 'operator')

    await goToSection(app, 'quarantine', 'operator')
    await runAction(app, {
      title: 'approve',
      values: [QUARANTINED_SERVER, SECOND_TOOL],
      command: `quarantine approve ${QUARANTINED_SERVER} ${SECOND_TOOL}`,
    })

    expect((await releaseRecords())[0]).toMatchObject({
      actor: { adminName: OPERATOR_NAME, role: 'operator', via: 'cli' },
      tool: SECOND_TOOL,
    })
    expect(app.errText()).not.toContain('Refusing')
  })

  test('a viewer is never shown the action, so no viewer release can be attempted', async () => {
    await seedQuarantine(QUARANTINED_TOOL)
    const app = await consoleAs(VIEWER_NAME, 'viewer')

    await goToSection(app, 'quarantine', 'viewer')

    expect(actionTitlesIn(app.fake.screen())).toEqual(['list', 'show'])
    // Reading stays open to them, and reading leaves no release record.
    await runAction(app, { title: 'list', command: 'quarantine list' })
    expect(await releaseRecords()).toEqual([])
  })
})

