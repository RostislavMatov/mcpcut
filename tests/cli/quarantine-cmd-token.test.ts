import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { QUARANTINE_RESOLVE_MIN_ROLE } from '../../src/admin/authz.js'
import { ADMIN_TOKEN_ENV_VAR, type AdminRole } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runQuarantine, type RunQuarantineOptions } from '../../src/cli/quarantine-cmd.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { createInventory, listAllQuarantined } from '../../src/policy/inventory.js'
import type { ToolDescriptor } from '../../src/protocol/mcp.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * Owner decision Q17 (2026-09-08): `quarantine approve|reject` — the three
 * mutating forms — need a personal admin token of role `operator` in
 * `MCP_ADMIN_TOKEN`, the SAME threshold the web UI's
 * `POST /quarantine/{approve,reject}` rows carry, and each one leaves both an
 * stderr audit line and an `access-edit` journal record naming the server,
 * the tool and the admin. `quarantine list|show` stay token-free.
 *
 * Until Q17 the UI rows were a barrier a shell walked around: the same
 * mutation from a terminal was unauthenticated AND unattributed, so the
 * journal could show an agent suddenly calling a tool nobody was recorded as
 * having released.
 *
 * Every case sets `env` explicitly, so a real `MCP_ADMIN_TOKEN` in the
 * developer's shell can never leak into a test.
 */

const SERVER = 'srv-a'
const TOOL = 'write_file'
const OTHER_TOOL = 'delete_file'

let journalDir: string
let storePath: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-quarantine-token-'))
  storePath = join(journalDir, 'tool-inventory.json')
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function fakeIo(): {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  out: () => string
  err: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

/** Puts `tools` in quarantine for `SERVER`, the way `tests/cli/quarantine-cmd.test.ts` does. */
async function seedQuarantine(...tools: readonly string[]): Promise<void> {
  const inventory = createInventory(SERVER, { storePath })
  const descriptors: ToolDescriptor[] = tools.map((name) => ({ name, description: 'seeded' }))
  await inventory.observeToolsList(descriptors)
}

/** Options with NO token: every refusal case. */
function anonOptions(): RunQuarantineOptions {
  return { storePath, journalDir, env: {} }
}

/** Mints an admin through the production store and returns options carrying its token. */
async function optionsForAdmin(name: string, role: AdminRole): Promise<RunQuarantineOptions> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(name, role)
  return { storePath, journalDir, env: { [ADMIN_TOKEN_ENV_VAR]: token } }
}

/** Names of the tools still quarantined for `SERVER`. */
async function stillQuarantined(): Promise<readonly string[]> {
  const entries = await listAllQuarantined(storePath)
  return entries.filter((entry) => entry.serverName === SERVER).map((entry) => entry.toolName)
}

/** The `access-edit` payloads the command left, in commit order. */
async function accessPayloads(): Promise<Array<Record<string, unknown>>> {
  const records = await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)
  return records.map((record) => record.payload as Record<string, unknown>)
}

describe('quarantine list|show stay ungated (Q17)', () => {
  test('list needs no token', async () => {
    await seedQuarantine(TOOL)
    const io = fakeIo()

    const exitCode = await runQuarantine(['list'], io, anonOptions())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain(TOOL)
  })

  test('show needs no token', async () => {
    await seedQuarantine(TOOL)
    const io = fakeIo()

    const exitCode = await runQuarantine(['show', SERVER, TOOL], io, anonOptions())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain(TOOL)
  })
})

describe('quarantine approve|reject refuse without a usable token (Q17)', () => {
  test('no token: approve is refused, exits 1, and the tool stays quarantined', async () => {
    await seedQuarantine(TOOL)
    const io = fakeIo()

    const exitCode = await runQuarantine(['approve', SERVER, TOOL], io, anonOptions())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(ADMIN_TOKEN_ENV_VAR)
    expect(await stillQuarantined()).toEqual([TOOL])
    expect(await accessPayloads()).toEqual([])
  })

  test('no token: reject is refused and discards nothing', async () => {
    await seedQuarantine(TOOL)
    const io = fakeIo()

    const exitCode = await runQuarantine(['reject', SERVER, TOOL], io, anonOptions())

    expect(exitCode).toBe(1)
    expect(await stillQuarantined()).toEqual([TOOL])
  })

  test('no token: approve --all is refused before a single tool is released', async () => {
    await seedQuarantine(TOOL, OTHER_TOOL)
    const io = fakeIo()

    const exitCode = await runQuarantine(['approve', '--all', '--server', SERVER], io, anonOptions())

    expect(exitCode).toBe(1)
    expect([...(await stillQuarantined())].sort()).toEqual([OTHER_TOOL, TOOL].sort())
  })

  test('a viewer token is refused: the role is below the shared threshold', async () => {
    await seedQuarantine(TOOL)
    const io = fakeIo()

    const exitCode = await runQuarantine(
      ['approve', SERVER, TOOL],
      io,
      await optionsForAdmin('watcher', 'viewer'),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(QUARANTINE_RESOLVE_MIN_ROLE)
    expect(await stillQuarantined()).toEqual([TOOL])
  })

  test('an unknown token is refused rather than silently treated as no token', async () => {
    await seedQuarantine(TOOL)
    const io = fakeIo()

    const exitCode = await runQuarantine(['approve', SERVER, TOOL], io, {
      storePath,
      journalDir,
      env: { [ADMIN_TOKEN_ENV_VAR]: 'mcpa_not-a-real-token' },
    })

    expect(exitCode).toBe(1)
    expect(await stillQuarantined()).toEqual([TOOL])
  })
})

describe('quarantine approve|reject with an operator token (Q17)', () => {
  test('approve releases the tool and records who released it', async () => {
    await seedQuarantine(TOOL)
    const io = fakeIo()

    const exitCode = await runQuarantine(
      ['approve', SERVER, TOOL],
      io,
      await optionsForAdmin('op', QUARANTINE_RESOLVE_MIN_ROLE),
    )

    expect(exitCode).toBe(0)
    expect(await stillQuarantined()).toEqual([])
    expect(io.err()).toContain('[audit]')
    expect(await accessPayloads()).toEqual([
      {
        actor: { adminName: 'op', role: QUARANTINE_RESOLVE_MIN_ROLE, via: 'cli' },
        action: 'quarantine.approve',
        server: SERVER,
        tool: TOOL,
      },
    ])
  })

  test('an owner token satisfies the operator threshold too', async () => {
    await seedQuarantine(TOOL)
    const io = fakeIo()

    const exitCode = await runQuarantine(
      ['reject', SERVER, TOOL],
      io,
      await optionsForAdmin('alice', 'owner'),
    )

    expect(exitCode).toBe(0)
    expect(await stillQuarantined()).toEqual([])
    const payloads = await accessPayloads()
    expect(payloads[0]).toEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'quarantine.reject',
      server: SERVER,
      tool: TOOL,
    })
  })

  test('approve --all writes one record per tool it released', async () => {
    await seedQuarantine(TOOL, OTHER_TOOL)
    const io = fakeIo()

    const exitCode = await runQuarantine(
      ['approve', '--all', '--server', SERVER],
      io,
      await optionsForAdmin('op', 'operator'),
    )

    expect(exitCode).toBe(0)
    expect(await stillQuarantined()).toEqual([])
    const payloads = await accessPayloads()
    expect(payloads).toHaveLength(2)
    expect(payloads.map((payload) => payload['tool']).sort()).toEqual([OTHER_TOOL, TOOL].sort())
    for (const payload of payloads) expect(payload['action']).toBe('quarantine.approve')
  })

  test('a tool that was never quarantined is still an error, and leaves no record', async () => {
    const io = fakeIo()

    const exitCode = await runQuarantine(
      ['approve', SERVER, TOOL],
      io,
      await optionsForAdmin('op', 'operator'),
    )

    expect(exitCode).toBe(1)
    expect(await accessPayloads()).toEqual([])
  })

  test('the admin token never reaches a journal record', async () => {
    await seedQuarantine(TOOL)
    const options = await optionsForAdmin('op', 'operator')
    const token = options.env?.[ADMIN_TOKEN_ENV_VAR]

    await runQuarantine(['approve', SERVER, TOOL], fakeIo(), options)

    expect(typeof token).toBe('string')
    expect(JSON.stringify(await accessPayloads())).not.toContain(token as string)
  })
})
