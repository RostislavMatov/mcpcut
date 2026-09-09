import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { AGENT_TOKEN_PREFIX } from '../../src/agents/constants.js'
import { JOURNAL_FILE_MODE } from '../../src/config.js'
import { POLICY_FILE_NAME } from '../../src/policy/constants.js'
import { EXIT_OK } from '../../src/tui/constants.js'
import {
  accessRecords,
  closeConsoles,
  goToSection,
  NO_KEY,
  openConsole,
  QUIT_KEY,
  REFRESH_KEY,
  runAction,
  signIn,
  storeBytes,
  waitForFinishedRun,
  waitForText,
  type RunningConsole,
} from './support/console-harness.js'

/**
 * The console end to end, part two (mcpcut phase 4, Task 11): the paths an
 * operator walks on their first day, with the REAL `dispatch` in the middle
 * and every seam on a temp directory.
 *
 * Phase 2's `console-e2e.test.ts` proved one command could travel from a
 * keystroke to a store and back. These three go the distance the catalogue
 * added: a secret into the vault, an empty installation onboarded up to a
 * granted agent under a policy rule, and a journal export written to a file
 * the pane only names.
 *
 * Each test asserts what only an end-to-end run can. That the vault's secret
 * reaches the command through the stdin seam and appears in NO frame, NO argv
 * and nowhere in the encrypted store. That the commands the console ran left
 * `access-edit` records naming the operator who ran them — the whole point of
 * the environment seam the session token travels in. That an export refuses a
 * path it would overwrite, and the console survives the refusal.
 */

/** The tail of `QUIT_WITH_TOKEN_QUESTION`, which survives the pane's wrapping. */
const QUIT_QUESTION_TAIL = 'Quit anyway? [y/N]'

/** The owner every test signs in as. */
const OWNER_NAME = 'root'

/** The secret typed into the vault form: it must not turn up anywhere else. */
const SECRET_NAME = 'github'
const SECRET_VALUE = 's3cr3t-value-9'

/** The installation these tests build: one server, one agent, one group. */
const SERVER_NAME = 'echo'
const AGENT_NAME = 'bot'
const GROUP_NAME = 'team'
const TOOL_RULE = 'get_x'

let journalDir: string
let store: AdminStore

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-onboarding-e2e-'))
  store = createAdminStore({ journalDir })
})

afterEach(async () => {
  await closeConsoles()
  await rm(journalDir, { recursive: true, force: true })
})

/** Signs a fresh owner into a fresh console over the temp journal directory. */
async function ownerConsole(): Promise<{ app: RunningConsole; token: string }> {
  const { token } = await store.createAdmin(OWNER_NAME, 'owner')
  const app = openConsole(journalDir)
  await signIn(app, token, OWNER_NAME, 'owner')
  return { app, token }
}

describe('console end to end: the vault', () => {
  test('sets a secret whose value reaches no frame, no argv and no file', async () => {
    const { app, token } = await ownerConsole()
    const { fake } = app

    await goToSection(app, 'vault', 'owner')
    await runAction(app, { title: 'init', command: 'vault init' })

    await runAction(app, {
      title: 'set',
      values: [SECRET_NAME, SECRET_VALUE],
      command: `vault set ${SECRET_NAME}`,
    })
    // The command line the pane prints names the secret and does not carry it:
    // the value went to `vault set`'s stdin reader through the seam.
    expect(fake.screen()).toContain(`secret "${SECRET_NAME}" set`)

    await runAction(app, { title: 'list', command: 'vault list' })
    expect(fake.screen()).toContain(SECRET_NAME)

    // The three places a secret must never be: a drawn frame, a command line,
    // and the encrypted store it was handed to.
    expect(fake.frames().every((frame) => !frame.includes(SECRET_VALUE))).toBe(true)
    expect(app.argvCalls().flat().every((argument) => !argument.includes(SECRET_VALUE))).toBe(true)
    const onDisk = await storeBytes(journalDir)
    // Guard the guard: a scan that read nothing would pass for the wrong reason.
    expect(onDisk).toContain(SECRET_NAME)
    expect(onDisk).not.toContain(SECRET_VALUE)

    // And the session token that bought the attribution is in none of them either.
    expect(fake.frames().every((frame) => !frame.includes(token))).toBe(true)
    expect(app.argvCalls().flat().every((argument) => !argument.includes(token))).toBe(true)
    expect(onDisk).not.toContain(token)
  })
})

describe('console end to end: onboarding an installation', () => {
  test('registers a server, an agent, a group and a rule, all from the console', async () => {
    const { app } = await ownerConsole()
    const { fake } = app

    // A server first: `agent grant` refuses a name the registry does not hold
    // (owner decision S1), so the order of these steps is the product's, not
    // the test's.
    await goToSection(app, 'servers', 'owner')
    await runAction(app, {
      title: 'add',
      values: [SERVER_NAME, '', 'node'],
      command: `server add ${SERVER_NAME} --transport stdio`,
    })
    await runAction(app, { title: 'list', command: 'server list' })
    expect(fake.screen()).toContain(SERVER_NAME)

    await goToSection(app, 'agents', 'owner')
    await runAction(app, {
      title: 'create',
      values: [AGENT_NAME],
      command: `agent create ${AGENT_NAME}`,
    })
    expect(fake.screen()).toContain(`token: ${AGENT_TOKEN_PREFIX}`)

    // The agent's token is a one-time token like an admin's, so `q` asks
    // before taking the screen — and the alternate screen — away with it.
    fake.type(QUIT_KEY)
    await waitForText(app, QUIT_QUESTION_TAIL, 'the quit confirmation')
    fake.type(NO_KEY)
    await waitForText(app, `token: ${AGENT_TOKEN_PREFIX}`, 'the output panel again')

    await runAction(app, {
      title: 'grant',
      values: [AGENT_NAME, SERVER_NAME, 'get_*'],
      command: `agent grant ${AGENT_NAME} ${SERVER_NAME} --tools get_*`,
    })

    await goToSection(app, 'groups', 'owner')
    await runAction(app, {
      title: 'create',
      values: [GROUP_NAME],
      command: `group create ${GROUP_NAME}`,
    })
    await runAction(app, {
      title: 'join',
      values: [GROUP_NAME, AGENT_NAME],
      command: `group join ${GROUP_NAME} ${AGENT_NAME}`,
    })

    // `policy set` edits a policy file, it does not create one: enforcement
    // being off is a state the operator must leave on purpose (ADR-0009), so
    // the minimal hand-written file is part of the fixture rather than a step.
    await writeFile(join(journalDir, POLICY_FILE_NAME), `${JSON.stringify({ version: 1 })}\n`)

    await goToSection(app, 'policy', 'owner')
    await runAction(app, {
      title: 'set',
      values: [SERVER_NAME, TOOL_RULE],
      command: `policy set ${SERVER_NAME} ${TOOL_RULE} allow`,
    })
    await runAction(app, { title: 'show', command: 'policy show' })
    expect(fake.screen()).toContain(TOOL_RULE)

    await goToSection(app, 'approvals', 'owner')
    await runAction(app, { title: 'list', command: 'approvals list' })
    expect(fake.screen()).toContain('no pending approvals')

    // What the session token bought: every mutation is journaled under the
    // name of the operator who made it, through the CLI the console ran.
    const actor = { adminName: OWNER_NAME, role: 'owner', via: 'cli' }
    const records = await accessRecords(journalDir)
    expect(records.map((record) => record['action'])).toEqual([
      'agent.create',
      'agent.grant',
      'group.create',
      'group.join',
    ])
    expect(records.every((record) => JSON.stringify(record['actor']) === JSON.stringify(actor))).toBe(
      true,
    )

    // The agent's own token is one-time in the same sense an admin's is: the
    // store keeps a hash, so no plaintext `mcpj_` is left behind.
    const onDisk = await storeBytes(journalDir)
    expect(onDisk).toContain(AGENT_NAME)
    expect(onDisk).not.toContain(AGENT_TOKEN_PREFIX)

    expect(app.errText()).toBe('')
  })
})

describe('console end to end: exporting the journal to a file', () => {
  test('writes JSONL at 0600 and refuses a second export to the same path', async () => {
    const { app } = await ownerConsole()
    const { fake } = app
    const exportPath = join(journalDir, 'export.jsonl')

    // Something to export: `agent create` leaves an `access-edit` record.
    await goToSection(app, 'agents', 'owner')
    await runAction(app, {
      title: 'create',
      values: [AGENT_NAME],
      command: `agent create ${AGENT_NAME}`,
    })

    await goToSection(app, 'journal', 'owner')
    await runAction(app, { title: 'export', values: [exportPath], command: 'export' })
    // The pane shows a receipt rather than the records: an export is unbounded
    // and the panel keeps 2 000 lines.
    expect(fake.screen()).toContain('bytes to ')

    const stats = await stat(exportPath)
    expect(stats.mode & 0o777).toBe(JOURNAL_FILE_MODE)

    const lines = (await readFile(exportPath, 'utf8')).split('\n').filter((line) => line !== '')
    expect(lines.length).toBeGreaterThan(0)
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.some((record) => record['kind'] === 'access-edit')).toBe(true)

    // The file is opened `wx`: a path that already exists is a failed run, not
    // an overwrite — and not a dead console either.
    await runAction(app, {
      title: 'export',
      values: [exportPath],
      command: 'export',
      exitCode: 1,
    })
    expect(fake.screen()).toContain('EEXIST')

    fake.type(REFRESH_KEY)
    await waitForFinishedRun(app, 'sessions')

    fake.type(QUIT_KEY)
    expect(await app.exit).toBe(EXIT_OK)
    expect(fake.restored()).toBe(true)
  })
})
