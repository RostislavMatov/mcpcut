import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AgentRecord } from '../../src/agents/schema.js'
import { startConnectSession } from '../../src/cli/connect-session.js'
import { createModelHandoff } from '../../src/cli/serve-hooks.js'
import { createServeSessionFactory } from '../../src/cli/serve-runtime.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import type { ServerRecord } from '../../src/registry/schema.js'
import { createMemorySink, createMemorySource } from '../session/memory-transport.js'
import { readJournal } from './serve-harness.js'

/**
 * End-to-end wiring of the known-secrets registry: a value the control plane
 * resolved from the vault and injected into an upstream must be redacted out
 * of that session's journal even when it has no recognisable secret shape and
 * the server echoes it back under an innocent name.
 *
 * The per-carrier redaction itself is covered by
 * `tests/redact/leak-regression.test.ts`; what these tests assert is that
 * `serve` and `connect` actually TELL the record builder which values they
 * handed out.
 */

const MARKER = 'WIREMARKER'
/** No prefix, no key context, nothing a pattern could ever match. */
const BARE_SECRET = `Qp7RtY2wLxV9${MARKER}nB3sCd6fGh1j`

const AGENT_NAME = 'bot'
const SERVER_NAME = 'testsrv'

const AGENT_RECORD: AgentRecord = {
  name: AGENT_NAME,
  tokenHash: 'a'.repeat(64),
  createdAt: '2026-08-01T00:00:00.000Z',
  grants: { [SERVER_NAME]: { tools: '*' } },
}

/** Leaks its own env var on stderr the moment it starts, then idles. */
const LEAKY_SERVER_SOURCE = `#!/usr/bin/env node
process.stderr.write('booting with ' + process.env.LEAK_TOKEN + '\\n')
process.stdin.resume()
`

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-known-secrets-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function policyOf(): Policy {
  const parsed = parsePolicy({ version: 1, defaultDecision: 'allow', quarantine: { enabled: false } })
  if (!parsed.ok) throw new Error('test policy is invalid')
  return parsed.policy
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out')
    await sleep(10)
  }
}

async function journalText(): Promise<string> {
  return JSON.stringify(await readJournal(journalDir))
}

describe('serve: a vault value the plane injected is redacted out of its own journal', () => {
  test('a bare secret echoed on the upstream’s stderr never reaches the journal', async () => {
    const serverPath = join(journalDir, 'leaky-server.mjs')
    await writeFile(serverPath, LEAKY_SERVER_SOURCE, 'utf8')
    await chmod(serverPath, 0o700)

    const record: ServerRecord = {
      name: SERVER_NAME,
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath],
      env: { LEAK_TOKEN: 'vault:leak' },
    }
    const handoff = createModelHandoff()
    handoff.note('sessionful')

    const openSession = createServeSessionFactory({
      registry: { getServer: () => Promise.resolve(record) },
      agents: { getAgent: () => Promise.resolve(AGENT_RECORD) },
      handoff,
      policy: policyOf(),
      journalDir,
      approvalsBaseDir: join(journalDir, 'approvals'),
      inventoryStorePath: join(journalDir, 'tool-inventory.json'),
      stderr: { write: () => true },
      upstream: {
        processEnv: {},
        envAllowlist: [],
        // Stands in for the vault: the declared `vault:leak` ref resolves to a
        // value of entirely arbitrary shape.
        resolveRefs: () => Promise.resolve({ status: 'resolved', values: { LEAK_TOKEN: BARE_SECRET } }),
      },
      newSessionId: () => 'known-secrets-serve',
      failClosed: false,
    })

    const opened = await openSession({ agentName: AGENT_NAME, serverName: SERVER_NAME })
    if ('error' in opened) throw new Error(`session refused: ${opened.error}`)
    try {
      await waitUntil(async () => (await journalText()).includes('booting with'))
    } finally {
      await opened.close()
    }

    const text = await journalText()
    expect(text).toContain('booting with')
    expect(text).not.toContain(MARKER)
  })
})

describe('connect: registered values reach the session’s record builder', () => {
  test('a bare secret echoed on the upstream’s stderr never reaches the journal', async () => {
    const run = startConnectSession({
      sessionId: 'known-secrets-connect',
      serverName: SERVER_NAME,
      agent: { record: AGENT_RECORD, store: { getAgent: () => Promise.resolve(AGENT_RECORD) } },
      client: { source: createMemorySource(), sink: createMemorySink() },
      server: { source: createMemorySource(), sink: createMemorySink() },
      policy: policyOf(),
      failClosed: false,
      journalDir,
      knownSecrets: [BARE_SECRET],
      onDiagnostic: () => undefined,
    })

    run.tapStderrLine(`booting with ${BARE_SECRET}`)
    await run.session.close('closed')
    await run.closeJournal()

    const text = await journalText()
    expect(text).toContain('booting with')
    expect(text).not.toContain(MARKER)
  })

  test('without registration the same value would reach the journal (the defect)', async () => {
    const run = startConnectSession({
      sessionId: 'known-secrets-connect-baseline',
      serverName: SERVER_NAME,
      agent: { record: AGENT_RECORD, store: { getAgent: () => Promise.resolve(AGENT_RECORD) } },
      client: { source: createMemorySource(), sink: createMemorySink() },
      server: { source: createMemorySource(), sink: createMemorySink() },
      policy: policyOf(),
      failClosed: false,
      journalDir,
      onDiagnostic: () => undefined,
    })

    run.tapStderrLine(`booting with ${BARE_SECRET}`)
    await run.session.close('closed')
    await run.closeJournal()

    expect(await journalText()).toContain(MARKER)
  })
})
