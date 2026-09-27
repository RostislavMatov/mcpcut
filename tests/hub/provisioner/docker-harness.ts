import { afterEach, beforeEach } from 'vitest'
import { createDockerClient, DockerApiError, type DockerClient } from '../../../hub/src/provisioner/docker.js'
import { startFakeDocker, type FakeDocker } from '../fake-docker.js'

/** Short enough to keep a timeout test fast, long enough for a loaded CI box. */
export const SHORT_TIMEOUT_MS = 150

export interface DockerContext {
  fake(): FakeDocker
  client(): DockerClient
  clientWith(options: { readonly timeoutMs?: number; readonly apiVersion?: string }): DockerClient
}

/** A fresh fake daemon and client per test; both are closed afterwards. */
export function useFakeDocker(): DockerContext {
  let fake: FakeDocker | undefined
  const clients: DockerClient[] = []
  const make = (options: { readonly timeoutMs?: number; readonly apiVersion?: string }): DockerClient => {
    const created = createDockerClient({ socketPath: current().socketPath, ...options })
    clients.push(created)
    return created
  }
  const current = (): FakeDocker => {
    if (fake === undefined) throw new Error('the fake daemon is not running')
    return fake
  }
  let defaultClient: DockerClient | undefined

  beforeEach(async () => {
    fake = await startFakeDocker()
    defaultClient = undefined
  })
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close()
    await fake?.close()
    fake = undefined
  })

  return {
    fake: current,
    client: () => {
      defaultClient ??= make({})
      return defaultClient
    },
    clientWith: make,
  }
}

/** Awaits `promise`, expecting a `DockerApiError`, and returns it. */
export async function dockerErrorOf(promise: Promise<unknown>): Promise<DockerApiError> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof DockerApiError) return error
    throw new Error(`expected DockerApiError, got ${String(error)}`)
  }
  throw new Error('expected the call to fail')
}

/** A container the tests can exec in: created and started. */
export async function runningContainer(client: DockerClient, name = 'mcpcut-t-alice'): Promise<string> {
  const { id } = await client.createContainer(name, { Image: 'mcpcut-tenant:local', Labels: { 'mcpcut.tenant': 'alice' } })
  await client.startContainer(id)
  return id
}
