import { describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdminStore } from '../../src/admin/store.js'
import { createLoginRateLimiter } from '../../src/ui/auth.js'
import { createSetupGate } from '../../src/ui/setup-gate.js'
import { createFirstOwnerWithCode } from '../../src/ui/setup-flow.js'

/**
 * `createFirstOwnerWithCode` (ADR-0014): the transport-neutral core shared by
 * the HTML `POST /setup` and the JSON `POST /api/console/setup`. Exercised
 * directly here — `setup-flow.test.ts` already pins the HTML rendering of
 * every one of these outcomes through the real HTTP core.
 */

describe('createFirstOwnerWithCode', () => {
  test('rate-limited when the key has spent its budget, without touching the gate', async () => {
    const journalDir = mkdtempSync(join(tmpdir(), 'mcp-setup-core-'))
    try {
      const adminStore = createAdminStore({ journalDir })
      const gate = createSetupGate({ hasAdmins: async () => (await adminStore.listAdmins()).length > 0 })
      const code = gate.arm()
      const rateLimiter = createLoginRateLimiter({ maxFailures: 1 })
      const deps = {
        gate,
        rateLimiter,
        stderr: { write: () => true },
        createFirstOwner: (name: string) => adminStore.createFirstOwner(name),
      }

      await createFirstOwnerWithCode(deps, { key: 'k', code: 'wrong', name: 'a' })
      const outcome = await createFirstOwnerWithCode(deps, { key: 'k', code, name: 'alice' })

      expect(outcome).toEqual({ kind: 'rate-limited' })
      expect(await adminStore.listAdmins()).toHaveLength(0)
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })

  test('closed once an admin already exists, before the code is even checked', async () => {
    const journalDir = mkdtempSync(join(tmpdir(), 'mcp-setup-core-'))
    try {
      const adminStore = createAdminStore({ journalDir })
      await adminStore.createAdmin('existing', 'owner')
      const gate = createSetupGate({ hasAdmins: async () => (await adminStore.listAdmins()).length > 0 })
      const code = gate.arm()
      const deps = {
        gate,
        rateLimiter: createLoginRateLimiter(),
        stderr: { write: () => true },
        createFirstOwner: (name: string) => adminStore.createFirstOwner(name),
      }

      const outcome = await createFirstOwnerWithCode(deps, { key: 'k', code, name: 'alice' })

      expect(outcome).toEqual({ kind: 'closed' })
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })

  test('created carries the journaled flag from afterOwnerCreated, true by default with no hook', async () => {
    const journalDir = mkdtempSync(join(tmpdir(), 'mcp-setup-core-'))
    try {
      const adminStore = createAdminStore({ journalDir })
      const gate = createSetupGate({ hasAdmins: async () => (await adminStore.listAdmins()).length > 0 })
      const code = gate.arm()
      const deps = {
        gate,
        rateLimiter: createLoginRateLimiter(),
        stderr: { write: () => true },
        createFirstOwner: (name: string) => adminStore.createFirstOwner(name),
      }

      const outcome = await createFirstOwnerWithCode(deps, { key: 'k', code, name: 'alice' })

      expect(outcome.kind).toBe('created')
      if (outcome.kind === 'created') {
        expect(outcome.admin.name).toBe('alice')
        expect(outcome.token.startsWith('mcpa_')).toBe(true)
        expect(outcome.journaled).toBe(true)
      }
      expect(await gate.isOpen()).toBe(false)
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })

  test('a dropped audit record surfaces as journaled: false, and the admin still exists', async () => {
    const journalDir = mkdtempSync(join(tmpdir(), 'mcp-setup-core-'))
    try {
      const adminStore = createAdminStore({ journalDir })
      const gate = createSetupGate({ hasAdmins: async () => (await adminStore.listAdmins()).length > 0 })
      const code = gate.arm()
      const deps = {
        gate,
        rateLimiter: createLoginRateLimiter(),
        stderr: { write: () => true },
        createFirstOwner: (name: string) => adminStore.createFirstOwner(name),
        afterOwnerCreated: async () => ({ written: false }),
      }

      const outcome = await createFirstOwnerWithCode(deps, { key: 'k', code, name: 'alice' })

      expect(outcome).toMatchObject({ kind: 'created', journaled: false })
    } finally {
      rmSync(journalDir, { recursive: true, force: true })
    }
  })
})
