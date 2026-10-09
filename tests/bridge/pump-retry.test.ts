import { describe, expect, test } from 'vitest'
import { ERROR_CODE_BRIDGE_TRANSPORT } from '../../src/bridge/constants.js'
import { BRIDGE_RETRY_ID_PREFIX } from '../../src/bridge/retry.js'
import { SessionExpiredError, UpstreamConnectionError, UpstreamHttpStatusError } from '../../src/transport/http/client.js'
import { clientMessage, serverMessage, type McpMessage } from '../../src/transport/message.js'
import { jsonOf, settle, startRig } from './pump-rig.js'

/**
 * Decision M39: the bridge sends a `tools/call` again after its connection
 * dropped — but only one carrying the client's tool-use id, which the service
 * matches to the first call (answer kept, or the call joined while it runs),
 * so it never runs twice. Each attempt goes under the bridge's own id; the
 * answer goes back to the client under the original one.
 */

const HOST = 'plane.example:8090'
const DELAYS = [5, 5, 5]

function dropped(): UpstreamConnectionError {
  return new UpstreamConnectionError('POST', HOST, Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
}

function toolCall(id: unknown, toolUseId?: string): McpMessage {
  const meta = toolUseId !== undefined ? { _meta: { 'claudecode/toolUseId': toolUseId, progressToken: 9 } } : {}
  return clientMessage(
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'write_file', arguments: { path: '/x' }, ...meta } })),
    '\n',
  )
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('a dropped tools/call with a tool-use id is sent again', () => {
  test('the next attempt goes under the bridge\'s own id, and its answer returns under the original one', async () => {
    // Arrange
    const rig = startRig({ retryDelaysMs: DELAYS })
    rig.serviceOut.failNext(dropped())

    // Act
    rig.clientIn.emit(toolCall(7, 'toolu_A'))
    await wait(30)

    // Assert: one attempt reached the service, under a fresh id, the call otherwise unchanged.
    expect(rig.serviceOut.written).toHaveLength(1)
    const attempt = jsonOf(rig.serviceOut.written[0]!)
    expect(String(attempt['id'])).toMatch(new RegExp(`^${BRIDGE_RETRY_ID_PREFIX}`))
    expect(attempt['params']).toEqual({ name: 'write_file', arguments: { path: '/x' }, _meta: { 'claudecode/toolUseId': 'toolu_A', progressToken: 9 } })
    expect(rig.diagnostics.join('')).toContain('sending it again')

    rig.serviceIn.emit(serverMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: attempt['id'], result: { content: [] } }))))
    await settle()
    expect(rig.clientOut.written.map(jsonOf)).toEqual([{ jsonrpc: '2.0', id: 7, result: { content: [] } }])

    rig.clientIn.end()
    await rig.ended
  })

  test('progress on the call\'s token reaches the client unchanged', async () => {
    const rig = startRig({ retryDelaysMs: DELAYS })
    rig.serviceOut.failNext(dropped())
    rig.clientIn.emit(toolCall(7, 'toolu_A'))
    await wait(30)

    const progress = serverMessage(Buffer.from('{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":9,"progress":1}}'))
    rig.serviceIn.emit(progress)
    await settle()

    expect(rig.clientOut.written).toEqual([progress])
    rig.clientIn.end()
    await rig.ended
  })

  test('every attempt failing: the client gets the transport error under its original id', async () => {
    const rig = startRig({ retryDelaysMs: DELAYS })
    for (let n = 0; n <= DELAYS.length; n += 1) rig.serviceOut.failNext(dropped())

    rig.clientIn.emit(toolCall(7, 'toolu_A'))
    await wait(80)

    expect(rig.serviceOut.written).toEqual([])
    const answer = jsonOf(rig.clientOut.written[0]!)
    expect(answer['id']).toBe(7)
    expect((answer['error'] as Record<string, unknown>)['code']).toBe(ERROR_CODE_BRIDGE_TRANSPORT)
    rig.clientIn.end()
    await rig.ended
  })
})

describe('what is never sent again', () => {
  test('a tools/call without a tool-use id: the transport error, as before', async () => {
    const rig = startRig({ retryDelaysMs: DELAYS })
    rig.serviceOut.failNext(dropped())

    rig.clientIn.emit(toolCall(7))
    await wait(30)

    expect(rig.serviceOut.written).toEqual([])
    expect(jsonOf(rig.clientOut.written[0]!)['id']).toBe(7)
    rig.clientIn.end()
    await rig.ended
  })

  test('a call the service answered with an HTTP error is not a dropped connection', async () => {
    const rig = startRig({ retryDelaysMs: DELAYS })
    rig.serviceOut.failNext(new UpstreamHttpStatusError(HOST, 500))

    rig.clientIn.emit(toolCall(7, 'toolu_A'))
    await wait(30)

    expect(rig.serviceOut.written).toEqual([])
    expect(jsonOf(rig.clientOut.written[0]!)['error']).toBeDefined()
    rig.clientIn.end()
    await rig.ended
  })

  test('a call the client cancelled before the next attempt: no attempt, no answer, the cancel goes on', async () => {
    const rig = startRig({ retryDelaysMs: [40] })
    rig.serviceOut.failNext(dropped())
    rig.clientIn.emit(toolCall(7, 'toolu_A'))
    await settle()

    const cancel = clientMessage(Buffer.from('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7,"reason":"user-cancel"}}'), '\n')
    rig.clientIn.emit(cancel)
    await wait(80)

    expect(rig.serviceOut.written).toEqual([cancel])
    expect(rig.clientOut.written).toEqual([])
    rig.clientIn.end()
    await rig.ended
  })

  test('a call cancelled while its first attempt was still out is not sent again when that one drops', async () => {
    const rig = startRig({ retryDelaysMs: DELAYS })
    const release = rig.serviceOut.holdNext()
    rig.serviceOut.failNext(dropped())
    rig.clientIn.emit(toolCall(7, 'toolu_A'))
    await settle()

    const cancel = clientMessage(Buffer.from('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}'), '\n')
    rig.clientIn.emit(cancel)
    await settle()
    release()
    await wait(40)

    expect(rig.serviceOut.written).toEqual([cancel])
    expect(rig.clientOut.written).toEqual([])
    rig.clientIn.end()
    await rig.ended
  })

  test('a cancel while an attempt is in flight cancels that attempt', async () => {
    const rig = startRig({ retryDelaysMs: [20] })
    rig.serviceOut.failNext(dropped())
    rig.clientIn.emit(toolCall(7, 'toolu_A'))
    await settle()
    // The first attempt failed; the next one (in 20 ms) will hang on the wire.
    const release = rig.serviceOut.holdNext()
    await wait(40)

    rig.clientIn.emit(clientMessage(Buffer.from('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7,"reason":"user-cancel"}}'), '\n'))
    await settle()
    release()
    await settle()

    const ids = rig.serviceOut.written.map(jsonOf)
    const attemptId = ids.find((message) => message['method'] === 'tools/call')?.['id']
    const cancel = ids.find((message) => message['method'] === 'notifications/cancelled')
    expect(String(attemptId)).toMatch(new RegExp(`^${BRIDGE_RETRY_ID_PREFIX}`))
    expect((cancel?.['params'] as Record<string, unknown>)['requestId']).toBe(attemptId)
    rig.clientIn.end()
    await rig.ended
  })

  test('a session the service forgot ends the bridge, as before', async () => {
    const rig = startRig({ retryDelaysMs: DELAYS })
    rig.serviceOut.failNext(dropped())
    rig.serviceOut.failNext(new SessionExpiredError(HOST))

    rig.clientIn.emit(toolCall(7, 'toolu_A'))

    expect(await rig.ended).toEqual({ reason: 'fatal', failure: { kind: 'session-expired' } })
  })
})
