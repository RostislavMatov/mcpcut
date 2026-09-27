import { afterEach, describe, expect, test } from 'vitest'
import { findAccountByGithubId } from '../../hub/src/accounts-db.js'
import { createHttpOrchestrator, type HttpOrchestrator } from '../../hub/src/orchestrator-http.js'
import { createProvisionerServer, type ProvisionerServer } from '../../hub/src/provisioner/server.js'
import { startHub, type HubHarness } from './harness.js'
import { CADDY, tenantObjects, useProvisioner } from './provisioner/provisioner-harness.js'

/**
 * The whole chain with no stand-in in the middle (plan `tenant-orchestrator`,
 * Task 5): the composed hub (`harness.ts`, fake GitHub) → the HTTP
 * orchestrator → the real provisioner server → the real service → the Docker
 * client → the fake Docker Engine. Sign in → `active` → `/account` → a new
 * owner token → delete → the container, the volume and the network are gone.
 */

const SECRET = 'e'.repeat(48)
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

async function startChain(provisionerUp = true): Promise<HubHarness> {
  let url = 'http://127.0.0.1:1'
  if (provisionerUp) {
    provisioner = createProvisionerServer({ service: ctx.service(), token: SECRET, log: () => undefined })
    url = `http://127.0.0.1:${(await provisioner.listen(0, '127.0.0.1')).port}`
  }
  orchestrator = createHttpOrchestrator({ url, token: SECRET })
  hub = await startHub({ orchestrator })
  return hub
}

const ALICE = { id: 7001, login: 'Alice', created_at: '2019-03-04T05:06:07Z' }

describe('hub → provisioner → Docker, end to end', () => {
  test('sign in, see the account, rotate the token, delete: the install comes and goes', async () => {
    const h = await startChain()
    const browser = h.browser()

    const created = await browser.signIn(ALICE)

    expect(created.status).toBe(200)
    const [firstToken] = ctx.tokens()
    expect(firstToken).toMatch(/^mcpa_/)
    expect(created.body).toContain(String(firstToken))
    expect(findAccountByGithubId(h.db, ALICE.id)).toMatchObject({ subdomain: 'alice', status: 'active' })
    expect(tenantObjects(ctx.fake())).toEqual({
      containers: ['mcpcut-t-alice'],
      networks: ['mcpcut-t-alice'],
      volumes: ['mcpcut-t-alice'],
    })
    const caddy = ctx.fake().containers().find((c) => c.name === CADDY)
    expect(ctx.fake().networks()[0]?.containers.has(String(caddy?.id))).toBe(true)

    const account = await browser.get('/account')
    expect(account.status).toBe(200)
    expect(account.body).toContain('alice.mcpcut.com')

    const rotated = await browser.post('/account/token')
    expect(rotated.status).toBe(200)
    const secondToken = ctx.tokens()[1]
    expect(secondToken).toBeDefined()
    expect(secondToken).not.toBe(firstToken)
    expect(rotated.body).toContain(String(secondToken))

    const deleted = await browser.post('/account/delete', { login: 'alice' })
    expect(deleted.status).toBe(200)
    expect(findAccountByGithubId(h.db, ALICE.id)).toBeNull()
    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: [], volumes: [] })

    const leaks = [...h.logs, ...ctx.logs()].join('\n')
    for (const token of ctx.tokens()) expect(leaks).not.toContain(token)
    expect(leaks).not.toContain(SECRET)
  })

  test('a failed create rolls the install back and the sign-in back: try again, no account', async () => {
    const h = await startChain()
    ctx.fake().failNext('POST /containers/{id}/start', 500, 'cannot start')

    const response = await h.browser().signIn(ALICE)

    expect(response.status).toBe(503)
    expect(response.body).toContain('Nothing was created')
    expect(findAccountByGithubId(h.db, ALICE.id)).toBeNull()
    expect(tenantObjects(ctx.fake())).toEqual({ containers: [], networks: [], volumes: [] })
    expect(h.logs.join('\n')).toContain('provisioner create: the provisioner answered HTTP 502 (docker)')
  })

  test('the provisioner is down: try again, no account, nothing in Docker', async () => {
    const h = await startChain(false)
    const dockerCallsBefore = ctx.fake().calls().length

    const response = await h.browser().signIn(ALICE)

    expect(response.status).toBe(503)
    expect(response.body).toContain('Nothing was created')
    expect(findAccountByGithubId(h.db, ALICE.id)).toBeNull()
    expect(ctx.fake().calls()).toHaveLength(dockerCallsBefore)
    expect(h.logs.join('\n')).toContain('could not be reached (ECONNREFUSED)')
  })

  test('a provisioner that does not know the hub’s secret refuses it; no account is created', async () => {
    provisioner = createProvisionerServer({ service: ctx.service(), token: 'x'.repeat(48), log: () => undefined })
    const url = `http://127.0.0.1:${(await provisioner.listen(0, '127.0.0.1')).port}`
    orchestrator = createHttpOrchestrator({ url, token: SECRET })
    hub = await startHub({ orchestrator })

    const response = await hub.browser().signIn(ALICE)

    expect(response.status).toBe(503)
    expect(findAccountByGithubId(hub.db, ALICE.id)).toBeNull()
    expect(hub.logs.join('\n')).toContain('HTTP 401 (unauthorized)')
    expect(tenantObjects(ctx.fake()).containers).toEqual([])
  })
})
