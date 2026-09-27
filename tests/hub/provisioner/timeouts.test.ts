import { describe, expect, test } from 'vitest'
import { CREATE_TIMEOUT_MS } from '../../../hub/src/orchestrator-http.js'
import { PROVISIONER_SOCKET_TIMEOUT_MS } from '../../../hub/src/provisioner/server.js'
import { ADMIN_EXEC_TIMEOUT_MS, READY_TIMEOUT_MS } from '../../../hub/src/provisioner/tenant-exec.js'
import { CREATE_DOCKER_MARGIN_MS } from '../../../hub/src/provisioner/timeouts.js'

/**
 * How long one create may take, end to end (security review of the
 * provisioner, LOW-1). The hub's client must outlast the provisioner's own
 * waits plus the Docker steps around them — otherwise the hub gives up on a
 * create that is about to succeed, and the person never sees the token their
 * install was minted with. The provisioner's socket must outlast the client,
 * so the client's timeout is the one that fires.
 */

const DOCKER_STEPS_MARGIN_MS = 30_000

describe('create timeouts', () => {
  test('readiness 45 s, admin add 20 s, the hub waits 120 s', () => {
    expect(READY_TIMEOUT_MS).toBe(45_000)
    expect(ADMIN_EXEC_TIMEOUT_MS).toBe(20_000)
    expect(CREATE_TIMEOUT_MS).toBe(120_000)
  })

  test('the hub waits longer than the provisioner’s waits plus at least 30 s for the Docker steps', () => {
    expect(CREATE_DOCKER_MARGIN_MS).toBeGreaterThanOrEqual(DOCKER_STEPS_MARGIN_MS)
    expect(CREATE_TIMEOUT_MS).toBeGreaterThan(READY_TIMEOUT_MS + ADMIN_EXEC_TIMEOUT_MS + DOCKER_STEPS_MARGIN_MS)
  })

  test('the provisioner keeps an idle socket longer than the hub waits', () => {
    expect(PROVISIONER_SOCKET_TIMEOUT_MS).toBeGreaterThan(CREATE_TIMEOUT_MS)
  })
})
