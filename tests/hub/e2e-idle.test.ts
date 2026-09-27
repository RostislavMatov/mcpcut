import { afterEach, describe, expect, test } from 'vitest'
import { findAccountByGithubId } from '../../hub/src/accounts-db.js'
import { createHttpOrchestrator, type HttpOrchestrator } from '../../hub/src/orchestrator-http.js'
import { createProvisionerServer, type ProvisionerServer } from '../../hub/src/provisioner/server.js'
import { HUB_TEST_START_MS, startHub, type HubHarness } from './harness.js'
import { execKindOf, tenantObjects, useProvisioner } from './provisioner/provisioner-harness.js'

/**
 * Idle installs through the whole chain (plan `hosted-path-and-ops`, Task C):
 * the hub's sweep → the HTTP orchestrator → the provisioner → the fake Docker
 * Engine, whose tenant answers `stat -c %Y` like the real one. An install its
 * agents keep writing to stays up whatever the last sign-in; one nobody used
 * for 60 days is stopped, and started again when its person signs in.
 */

const SECRET = 'i'.repeat(48)
const DAY = 24 * 60 * 60 * 1000
const ctx = useProvisioner()
let hub: HubHarness | undefined
let provisioner: ProvisionerServer | undefined
let orchestrator: HttpOrchestrator | undefined

afterEach(async () => {
  await hub?.close()
  await provisioner?.close()
  orchestrator?.close()
  hub = undefined
  provisioner = undefined
  orchestrator = undefined
})

const ALICE = { id: 7001, login: 'Alice', created_at: '2019-03-04T05:06:07Z' }

async function aliceActive(): Promise<HubHarness> {
  provisioner = createProvisionerServer({ service: ctx.service(), token: SECRET, log: () => undefined })
  const url = `http://127.0.0.1:${(await provisioner.listen(0, '127.0.0.1')).port}`
  orchestrator = createHttpOrchestrator({ url, token: SECRET })
  hub = await startHub({ orchestrator })
  const browser = hub.browser()
  await browser.signIn(ALICE)
  await hub.settle()
  await browser.get('/account')
  return hub
}

const aliceRunning = (): boolean | undefined => ctx.fake().containers().find((c) => c.name === 'mcpcut-t-alice')?.running

describe('hub → provisioner → Docker: idle installs', () => {
  test('agents writing the journal keep an install up, whatever the last sign-in', async () => {
    const h = await aliceActive()
    h.advance(70 * DAY)
    const recentS = Math.floor((h.nowMs() - DAY) / 1000)
    ctx.answer((argv) => (execKindOf(argv) === 'stat' ? { exitCode: 1, stdout: `${recentS}\n` } : undefined))

    const summary = await h.server.sweep()

    expect(summary.entries.map((entry) => [entry.outcome, entry.idleDays])).toEqual([['keep', 1]])
    expect(aliceRunning()).toBe(true)
  })

  test('60 unused days: stopped; a sign-in starts it again; the data stays', async () => {
    const h = await aliceActive()
    h.advance(61 * DAY)

    await h.server.sweep()
    expect(aliceRunning()).toBe(false)
    expect(findAccountByGithubId(h.db, ALICE.id)?.stoppedAt).toBe(new Date(HUB_TEST_START_MS + 61 * DAY).toISOString())
    expect(tenantObjects(ctx.fake()).volumes).toEqual(['mcpcut-t-alice'])

    await h.browser().signIn(ALICE)
    await h.settle()

    expect(aliceRunning()).toBe(true)
    expect(findAccountByGithubId(h.db, ALICE.id)?.stoppedAt).toBeNull()
  })

  test('90 unused days: the install and its volume are gone, and so is the account', async () => {
    const h = await aliceActive()
    h.advance(91 * DAY)

    await h.server.sweep()

    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: [], volumes: [] })
    expect(findAccountByGithubId(h.db, ALICE.id)).toBeNull()
  })
})
