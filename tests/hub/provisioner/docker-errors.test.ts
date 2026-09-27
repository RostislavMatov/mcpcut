import http from 'node:http'
import { describe, expect, test, vi } from 'vitest'
import {
  DOCKER_MAX_RESPONSE_BYTES,
  DOCKER_MESSAGE_MAX_CHARS,
  DockerApiError,
  createDockerClient,
} from '../../../hub/src/provisioner/docker.js'
import { SHORT_TIMEOUT_MS, dockerErrorOf, runningContainer, useFakeDocker } from './docker-harness.js'

const ctx = useFakeDocker()
const SECRET = 'hunter2-0123456789abcdef-secret-value'

interface PoolView {
  addRequest(...args: unknown[]): void
}

describe('DockerApiError', () => {
  test('carries the status, Docker’s message and the operation, and nothing else', async () => {
    ctx.fake().failNext('POST /containers/create', 500, 'something broke in the daemon')

    const error = await dockerErrorOf(ctx.client().createContainer('c1', { Image: 'img' }))

    expect(error).toBeInstanceOf(DockerApiError)
    expect(error.name).toBe('DockerApiError')
    expect(error.failure).toBe('http-status')
    expect(error.status).toBe(500)
    expect(error.notFound).toBe(false)
    expect(error.dockerMessage).toBe('something broke in the daemon')
    expect(error.message).toBe('container create: Docker answered HTTP 500: something broke in the daemon')
  })

  test(`Docker's message is cut to ${200} characters and stripped of control characters`, async () => {
    ctx.fake().failNext('DELETE /volumes/{name}', 500, `line1\nline2\u001b[31m\u202e${'x'.repeat(500)}`)

    const error = await dockerErrorOf(ctx.client().removeVolume('v1'))

    expect(DOCKER_MESSAGE_MAX_CHARS).toBe(200)
    expect(error.dockerMessage?.length).toBeLessThanOrEqual(DOCKER_MESSAGE_MAX_CHARS)
    expect(error.dockerMessage).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/)
    expect(error.dockerMessage?.startsWith('line1 line2')).toBe(true)
  })

  test('the request body is never quoted, and env values Docker echoes are redacted', async () => {
    ctx.fake().failNext('POST /containers/create', 400, `invalid environment variable: TOKEN=${SECRET}`)

    const error = await dockerErrorOf(
      ctx.client().createContainer('c1', { Image: 'img', Env: [`TOKEN=${SECRET}`, 'MCPCUT_TENANT=1'] }),
    )

    expect(error.message).not.toContain(SECRET)
    expect(error.dockerMessage).not.toContain(SECRET)
    expect(error.message).toContain('TOKEN=[redacted]')
  })

  test('exec env values Docker echoes are redacted too', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)
    ctx.fake().failNext('POST /containers/{id}/exec', 400, `bad env ${SECRET}`)

    const error = await dockerErrorOf(client.exec(id, ['x'], { env: { MCPCUT_ADMIN_TOKEN: SECRET } }))

    expect(error.message).not.toContain(SECRET)
    expect(JSON.stringify(error)).not.toContain(SECRET)
  })

  test('a body that is not JSON gives a status-only error, never the raw body', async () => {
    ctx.fake().replyNext('POST /networks/create', { status: 500, body: `<html>${SECRET}</html>`, contentType: 'text/html' })

    const error = await dockerErrorOf(ctx.client().createNetwork('n1', {}))

    expect(error.message).toBe('network create: Docker answered HTTP 500')
    expect(error.dockerMessage).toBeUndefined()
  })

  test('an answer over 1 MiB is refused as bad-response', async () => {
    ctx.fake().replyNext('GET /containers/json', { status: 200, body: `[${'"x",'.repeat(300_000)}"x"]` })

    const error = await dockerErrorOf(ctx.client().listContainers({ label: 'a' }))

    expect(DOCKER_MAX_RESPONSE_BYTES).toBe(1024 * 1024)
    expect(error.failure).toBe('bad-response')
    expect(error.message).toMatch(/exceeds/)
  })

  test('an answer over 1 MiB without Content-Length is cut off while reading', async () => {
    ctx.fake().replyNext('GET /containers/json', { status: 200, body: `[${'"x",'.repeat(300_000)}"x"]`, omitLength: true })

    const error = await dockerErrorOf(ctx.client().listContainers({ label: 'a' }))

    expect(error.failure).toBe('bad-response')
    expect(error.message).toMatch(/exceeds/)
  })

  test('a success answer of the wrong shape is bad-response naming fields, not values', async () => {
    ctx.fake().replyNext('GET /containers/{id}/json', { status: 200, body: JSON.stringify({ Id: 42, Name: SECRET }) })

    const error = await dockerErrorOf(ctx.client().inspectContainer('c1'))

    expect(error.failure).toBe('bad-response')
    expect(error.message).not.toContain(SECRET)
  })

  test('a success answer that is not JSON is bad-response without quoting it', async () => {
    ctx.fake().replyNext('POST /containers/create', { status: 201, body: `not json ${SECRET}` })

    const error = await dockerErrorOf(ctx.client().createContainer('c1', { Image: 'img' }))

    expect(error.failure).toBe('bad-response')
    expect(error.message).not.toContain(SECRET)
  })

  test('an unexpected success status is an error (e.g. 200 where Docker answers 201)', async () => {
    ctx.fake().replyNext('POST /containers/create', { status: 200, body: JSON.stringify({ Id: 'x', Warnings: [] }) })

    expect((await dockerErrorOf(ctx.client().createContainer('c1', { Image: 'img' }))).status).toBe(200)
  })

  test('a request with no answer within timeoutMs is a timeout', async () => {
    ctx.fake().hangNext('POST /volumes/create')

    const error = await dockerErrorOf(ctx.clientWith({ timeoutMs: SHORT_TIMEOUT_MS }).createVolume('v1', {}))

    expect(error.failure).toBe('timeout')
    expect(error.notFound).toBe(false)
    expect(error.message).toMatch(/no answer within 150 ms/)
  })

  test('a missing socket is unreachable, naming only the errno code', async () => {
    const client = createDockerClient({ socketPath: `${ctx.fake().socketPath}.missing` })
    try {
      const error = await dockerErrorOf(client.listContainers({ label: 'a' }))

      expect(error.failure).toBe('unreachable')
      expect(error.message).toMatch(/\((ENOENT|ECONNREFUSED)\)$/)
      expect(error.message).not.toContain(ctx.fake().socketPath)
    } finally {
      client.close()
    }
  })

  test('the client uses its own agent, never the global one', async () => {
    const spy = vi.spyOn(http.globalAgent as unknown as PoolView, 'addRequest')
    const client = ctx.client()
    const id = await runningContainer(client)

    await client.listContainers({ label: 'a' })
    await client.exec(id, ['true'], {})

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  test('a closed client refuses further calls without touching the daemon', async () => {
    const client = ctx.client()
    client.close()

    const error = await dockerErrorOf(client.listContainers({ label: 'a' }))

    expect(error.failure).toBe('unreachable')
    expect(ctx.fake().calls()).toEqual([])
  })
})
