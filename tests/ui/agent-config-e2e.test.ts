import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { HARNESS_SERVE_ADDRESS, startUiHarness, type UiTestHarness } from './harness.js'

/**
 * The client config on the web, over real sockets (ADR-0015, PRD phase 4).
 * The PRD metric "the agent token is nowhere but in `env`" is a claim about
 * every byte the UI writes, so it is checked against the harness transcript:
 * the token appears in ONE response — the answer to the create — and in no
 * later page, not even the `/agents` page that shows the block with `<token>`.
 */

let harness: UiTestHarness | undefined
let journalDir: string | undefined

afterEach(async () => {
  await harness?.stop()
  harness = undefined
  if (journalDir !== undefined) await rm(journalDir, { recursive: true, force: true })
  journalDir = undefined
})

describe('the agent token over the wire', () => {
  test('appears in exactly one HTTP response — the create — however many pages show the client config', async () => {
    journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-agent-config-e2e-'))
    harness = await startUiHarness({ journalDir })
    const owner = await harness.login('ui-owner')

    const created = await owner.post('/agents/create', { name: 'research-bot' })
    const token = /data-token>([^<]+)</.exec(created.body)?.[1] as string
    const listed = await owner.get('/agents')
    const viewer = await harness.login('ui-viewer')
    const listedAsViewer = await viewer.get('/agents')

    expect(created.status).toBe(200)
    expect(token).toMatch(/^mcpj_/)
    // Twice in the one response: the token box and the block's env — the
    // http form's header is a third, all on the one page that reveals it.
    expect(created.body).toContain(HARNESS_SERVE_ADDRESS.url)
    for (const page of [listed, listedAsViewer]) {
      expect(page.status).toBe(200)
      expect(page.body).toContain('data-client-config="stdio"')
      expect(page.body).not.toContain(token)
    }
    // The harness records each response as `<status> <headers JSON>\n<body>`.
    const responses = harness.transcript().split(/\n(?=\d{3} \{)/)
    expect(responses.length).toBeGreaterThanOrEqual(4)
    expect(responses.filter((response) => response.includes(token))).toHaveLength(1)
  })
})
