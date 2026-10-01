import { statSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runExportCommand } from '../../src/cli/export-cmd.js'
import { REPORT_FILES } from '../../src/journal/report.js'
import { createJournalSink } from '../../src/journal/sink.js'

/**
 * Windows refuses to fsync a directory (EPERM). The smoke of the published
 * 0.2.4 on Windows found `export --report` dying on exactly that after every
 * file was written, so the Prove step of the Quick start failed there. This
 * file reproduces the platform: every directory handle's `sync()` rejects
 * with EPERM, as on Windows; file handles behave normally.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (typeof args[0] === 'string' && statSync(args[0]).isDirectory()) {
        handle.sync = () => Promise.reject(Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' }))
      }
      return handle
    },
  }
})

let journalDir: string
let outDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-export-dir-sync-journal-'))
  outDir = join(await mkdtemp(join(tmpdir(), 'mcpcut-export-dir-sync-out-')), 'report')
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
  await rm(outDir, { recursive: true, force: true })
})

function fakeIo(): { stdout: { write: (chunk: string) => void }; stderr: { write: (chunk: string) => void }; err: () => string } {
  const errChunks: string[] = []
  return {
    stdout: { write: () => undefined },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    err: () => errChunks.join(''),
  }
}

describe('export --report on a platform that refuses directory fsync', () => {
  test('writes the report and exits 0', async () => {
    const sink = createJournalSink('session-win', { dir: journalDir })
    sink.write({
      id: '01AAAAAAAAAAAAAAAAAAAAAAA0',
      ts: new Date().toISOString(),
      sessionId: 'session-win',
      direction: 'client→server',
      kind: 'request',
      method: 'tools/list',
      payload: {},
    })
    await sink.close()
    const io = fakeIo()

    const exitCode = await runExportCommand(['--report', '--out', outDir], io, { journalDir })

    expect(io.err()).not.toContain('EPERM')
    expect(exitCode).toBe(0)
    expect((await readdir(outDir)).sort()).toEqual([REPORT_FILES.manifest, REPORT_FILES.records, REPORT_FILES.summary].sort())
  })
})
