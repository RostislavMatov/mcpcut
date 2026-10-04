import { describe, expect, test } from 'vitest'
import { buildAccessEditRecord } from '../../src/journal/access-edit-record.js'

/** The two trash actions of the file module (ADR-0020 §4): one flat record each, no extra keys. */

const NOW_MS = Date.UTC(2026, 9, 4, 12, 0, 0)
const ACTOR = { adminName: 'alice', role: 'owner', via: 'cli' } as const
const TRASH_ID = '01K9Z3Q8M5R7T2V4X6B8D0F1GH'

function payloadOf(info: Parameters<typeof buildAccessEditRecord>[0]['info']): Record<string, unknown> {
  return buildAccessEditRecord({ info, clock: () => NOW_MS }).payload as Record<string, unknown>
}

describe('files.trash.* access-edit records', () => {
  test('a restore names the restored path and the trash id', () => {
    const payload = payloadOf({ actor: ACTOR, action: 'files.trash.restore', path: '/data/a/b.txt', trashId: TRASH_ID })

    expect(payload).toEqual({ actor: ACTOR, action: 'files.trash.restore', path: '/data/a/b.txt', trashId: TRASH_ID })
  })

  test('a purge names the root, the window and the count', () => {
    const payload = payloadOf({ actor: ACTOR, action: 'files.trash.purge', path: '/data', olderThan: '30d', deletedCount: 4 })

    expect(payload).toEqual({ actor: ACTOR, action: 'files.trash.purge', path: '/data', olderThan: '30d', deletedCount: 4 })
  })

  test('a purge of nothing still records a zero count', () => {
    const payload = payloadOf({ actor: ACTOR, action: 'files.trash.purge', path: '/data', olderThan: '30d', deletedCount: 0 })

    expect(payload['deletedCount']).toBe(0)
  })

  test('trashId stays absent on actions that do not use it', () => {
    const payload = payloadOf({ actor: ACTOR, action: 'files.root.add', path: '/data' })

    expect(Object.hasOwn(payload, 'trashId')).toBe(false)
  })
})
