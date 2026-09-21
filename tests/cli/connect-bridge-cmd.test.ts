import { PassThrough, Writable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { EXIT_CODE_BRIDGE_LOST } from '../../src/bridge/constants.js'
import { AGENT_TOKEN_MARKER } from '../../src/cli/connect-bridge-messages.js'
import { isBridgeInvocation, runConnectBridge } from '../../src/cli/connect-bridge-cmd.js'
import { AGENT_TOKEN_ENV_VAR } from '../../src/cli/connect-constants.js'
import { AGENT_TOKEN_PREFIX } from '../../src/agents/constants.js'
import {
  SessionExpiredError,
  SseStreamError,
  UpstreamHttpStatusError,
  type HttpUpstreamClient,
  type HttpUpstreamRecord,
} from '../../src/transport/http/client.js'
import type { McpMessage, MessageSource } from '../../src/transport/message.js'
import { waitUntil } from '../proxy/harness.js'
import { createCliCapture } from './connect-harness.js'

/**
 * `mcpcut connect --url` as a command (plan task 5): which invocations it
 * refuses and in what order, and which exit code each ending earns.
 *
 * Every refusal here is asserted to happen with the HTTP client factory
 * NEVER called — that is the actual claim, not the exit code: a refusal that
 * dialed first would already have put the token on the wire.
 */

const TOKEN = `${AGENT_TOKEN_MARKER}bridge-cmd-test`
const URL = 'https://plane.example:8090/agents/reader/servers/files'

interface FakeClient {
  readonly created: Array<{ record: HttpUpstreamRecord }>
  readonly factory: (record: HttpUpstreamRecord) => HttpUpstreamClient
  /** Reports an error on the service-side source, as the real client does. */
  fail(error: unknown): void
  closes(): number
}

function fakeClient(): FakeClient {
  const created: Array<{ record: HttpUpstreamRecord }> = []
  let onError: ((error: unknown) => void) | undefined
  let closes = 0

  const source: MessageSource = {
    onMessage: () => undefined,
    onError: (handler) => {
      onError = handler
    },
    onEnd: () => undefined,
    dispose: () => undefined,
  }

  return {
    created,
    factory: (record: HttpUpstreamRecord) => {
      created.push({ record })
      return {
        source,
        sink: { write: (_message: McpMessage) => Promise.resolve(), dispose: () => undefined },
        close: () => {
          closes += 1
          return Promise.resolve()
        },
      }
    },
    fail: (error: unknown) => onError?.(error),
    closes: () => closes,
  }
}

interface RunArgs {
  readonly argv: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

function startRun(args: RunArgs) {
  const io = createCliCapture()
  const client = fakeClient()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.resume()

  const code = runConnectBridge(args.argv, io, {
    env: args.env ?? { [AGENT_TOKEN_ENV_VAR]: TOKEN },
    stdin,
    stdout,
    createClient: client.factory,
  })

  return { io, client, stdin, stdout, code }
}

/** Runs one invocation that is expected to refuse before dialing anything. */
async function runRefusal(args: RunArgs) {
  const run = startRun(args)
  const code = await run.code
  return { code, err: run.io.err(), out: run.io.out(), created: run.client.created.length }
}

describe('isBridgeInvocation picks the remote form out of raw argv', () => {
  test.each([
    [['--url', 'https://h'], true],
    [['--url=https://h'], true],
    [['--url'], true],
    [['files', '--agent', 'reader'], false],
    [['--fail-closed'], false],
    [[], false],
    // Not `--url`: a different flag that merely starts the same way.
    [['--urls', 'x'], false],
  ] as const)('%j → %s', (argv, expected) => {
    expect(isBridgeInvocation([...argv])).toBe(expected)
  })
})

describe('a token in argv is refused before anything else', () => {
  test.each([
    ['a bare positional', ['--url', URL, TOKEN]],
    ['--token', ['--url', URL, '--token', TOKEN]],
    ['--token=', [`--token=${TOKEN}`, '--url', URL]],
    ['--header', ['--url', URL, '--header', `authorization: Bearer ${TOKEN}`]],
    ['a token smuggled into the address', [`--url=https://h/?t=${TOKEN}`]],
  ])('%s: refused, nothing dialed, nothing echoed', async (_name, argv) => {
    const result = await runRefusal({ argv })

    expect(result.code).toBe(1)
    expect(result.created).toBe(0)
    expect(result.err).toContain(AGENT_TOKEN_ENV_VAR)
    expect(result.err).toContain('ps')
    // The whole point of refusing: the value must not be logged.
    expect(result.err).not.toContain(TOKEN)
    expect(result.out).toBe('')
  })

  test('the marker it screens for is the real token prefix', () => {
    // Pins the local copy (which exists so this command imports no module
    // that reaches `src/config.ts`) to the store's own constant.
    expect(AGENT_TOKEN_MARKER).toBe(AGENT_TOKEN_PREFIX)
  })
})

describe('the two forms of connect are not mixed', () => {
  test('a server name alongside --url earns its own explanation', async () => {
    const result = await runRefusal({ argv: ['files', '--url', URL] })

    expect(result.code).toBe(1)
    expect(result.created).toBe(0)
    expect(result.err).toContain('--url')
  })

  test('--agent alongside --url says which two commands were mixed', async () => {
    const result = await runRefusal({ argv: ['--url', URL, '--agent', 'reader'] })

    expect(result.code).toBe(1)
    expect(result.created).toBe(0)
    expect(result.err).toContain('REMOTE form')
  })

  test('an unknown flag prints the usage rather than a parser message', async () => {
    const result = await runRefusal({ argv: ['--url', URL, '--nonsense'] })

    expect(result.code).toBe(1)
    expect(result.created).toBe(0)
    expect(result.err).toContain('Usage:')
  })

  test('--url without a value prints the usage', async () => {
    const result = await runRefusal({ argv: ['--url'] })

    expect(result.code).toBe(1)
    expect(result.created).toBe(0)
    expect(result.err).toContain('Usage:')
  })
})

describe('the address is judged before anything is dialed', () => {
  test('a bad address is refused', async () => {
    const result = await runRefusal({ argv: ['--url', 'plane.example:8090'] })

    expect(result.code).toBe(1)
    expect(result.created).toBe(0)
    expect(result.err).toContain('--url')
  })

  test('plain http to another host is refused, naming both ways out (PE8)', async () => {
    const result = await runRefusal({ argv: ['--url', 'http://10.0.0.5:8090'] })

    expect(result.code).toBe(1)
    expect(result.created).toBe(0)
    expect(result.err).toContain('--allow-http')
    expect(result.err).toContain('ssh -L')
    expect(result.err).toContain('https://')
  })

  test('--allow-http turns that into exactly one warning, and the bridge runs', async () => {
    const run = startRun({ argv: ['--url', 'http://10.0.0.5:8090', '--allow-http'] })
    run.stdin.end()
    const code = await run.code

    expect(code).toBe(0)
    expect(run.client.created).toHaveLength(1)
    expect(run.io.err().split('warning:').length - 1).toBe(1)
  })

  test('loopback over plain http needs no flag and earns no warning', async () => {
    const run = startRun({ argv: ['--url', 'http://127.0.0.1:8090'] })
    run.stdin.end()
    const code = await run.code

    expect(code).toBe(0)
    expect(run.io.err()).not.toContain('warning:')
  })
})

describe('the token comes from the environment, or the command refuses', () => {
  test.each([
    ['unset', {}],
    ['empty', { [AGENT_TOKEN_ENV_VAR]: '' }],
  ])('%s: refused, nothing dialed', async (_name, env) => {
    const result = await runRefusal({ argv: ['--url', URL], env })

    expect(result.code).toBe(1)
    expect(result.created).toBe(0)
    expect(result.err).toContain(AGENT_TOKEN_ENV_VAR)
  })

  test('the refusal order puts the address ahead of the missing token', async () => {
    // Both are wrong; the operator hears about the one they can see.
    const result = await runRefusal({ argv: ['--url', 'ftp://plane.example'], env: {} })

    expect(result.err).toContain('--url')
    expect(result.err).not.toContain('is not set')
  })
})

describe('what the HTTP client is built with', () => {
  test('the bearer token, the endpoint, and no other header', async () => {
    const run = startRun({ argv: ['--url', 'https://plane.example:8090'] })
    run.stdin.end()
    await run.code

    const record = run.client.created[0]?.record
    // A bare origin means the pool endpoint (PE5).
    expect(record?.url).toBe('https://plane.example:8090/mcp')
    expect(record?.headers).toEqual({ authorization: `Bearer ${TOKEN}` })
    // The bridge must not choose a session model on the service's behalf.
    expect(record?.protocol).toBe('auto')
  })
})

describe('each ending earns its own exit code and its own line', () => {
  test('the client hanging up is exit 0, silently', async () => {
    const run = startRun({ argv: ['--url', URL] })
    run.stdin.end()

    expect(await run.code).toBe(0)
    expect(run.io.err()).toBe('')
  })

  test.each([
    ['401', () => new UpstreamHttpStatusError('POST', 401, 'plane.example:8090'), 1, 'did not accept'],
    ['403', () => new UpstreamHttpStatusError('POST', 403, 'plane.example:8090'), 1, '403'],
    ['404', () => new UpstreamHttpStatusError('POST', 404, 'plane.example:8090'), 1, '404'],
    [
      'an expired session',
      () => new SessionExpiredError('plane.example:8090'),
      EXIT_CODE_BRIDGE_LOST,
      'no longer knows this session',
    ],
    [
      'a lost stream',
      () => new SseStreamError('plane.example:8090', 5, null),
      EXIT_CODE_BRIDGE_LOST,
      'event stream',
    ],
  ])('%s → exit %i', async (_name, makeError, expectedCode, hint) => {
    const run = startRun({ argv: ['--url', URL] })
    run.client.fail(makeError())

    expect(await run.code).toBe(expectedCode)
    expect(run.io.err()).toContain(hint)
    // The origin, never the path: the agent and server names stay out of it,
    // exactly as they do in the HTTP client's own errors.
    expect(run.io.err()).toContain('plane.example:8090')
    expect(run.io.err()).not.toContain('/agents/reader')
  })

  test('a 404 on a pool address explains that the endpoint does not exist yet', async () => {
    const run = startRun({ argv: ['--url', 'https://plane.example:8090'] })
    run.client.fail(new UpstreamHttpStatusError('POST', 404, 'plane.example:8090'))

    await run.code
    expect(run.io.err()).toContain('agent pool endpoint')
    expect(run.io.err()).toContain('/agents/<agent>/servers/<server>')
  })

  test('a protocol channel that cannot be written to is reported on stderr', async () => {
    const io = createCliCapture()
    const client = fakeClient()
    const stdin = new PassThrough()
    // A stdout that refuses everything: the client process died, and its pipe
    // with it. The bridge reports it and ends — it does not try to tell the
    // client about its own broken channel.
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('EPIPE'))
      },
    })

    const done = runConnectBridge(['--url', URL], io, {
      env: { [AGENT_TOKEN_ENV_VAR]: TOKEN },
      stdin,
      stdout,
      createClient: (record) => {
        const real = client.factory(record)
        // The one thing that makes the bridge write to the client on its own:
        // a request it could not deliver and therefore owes an answer.
        return {
          ...real,
          sink: {
            write: () =>
              Promise.reject(
                new UpstreamHttpStatusError('POST', 503, 'plane.example:8090'),
              ),
            dispose: () => undefined,
          },
        }
      },
    })
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
    // Polled, not slept: a fixed wait passes or fails with the machine's load.
    await waitUntil(() => io.err().includes('client stdout'))
    stdin.end()
    await done

    expect(io.err()).toContain('client stdout')
  })

  test('the service connection is closed however the bridge ended', async () => {
    const run = startRun({ argv: ['--url', URL] })
    run.client.fail(new UpstreamHttpStatusError('POST', 401, 'plane.example:8090'))
    await run.code

    expect(run.client.closes()).toBeGreaterThanOrEqual(1)
  })
})
