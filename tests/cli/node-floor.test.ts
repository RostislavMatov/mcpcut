import { describe, expect, test } from 'vitest'
import { MIN_NODE_MAJOR, nodeFloorProblem } from '../../src/cli/node-floor.js'

/**
 * The runtime floor message (`connect --url` plan, task 1).
 *
 * `mcpcut` is now something an agent's client config runs on a machine that
 * never ran `setup` — quite possibly on whatever Node that machine happens to
 * have. On Node 23 and older the first import of `store/sqlite.ts` throws
 * `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` before any command has had a
 * chance to explain itself. This function is the explanation; the install
 * half (`node-floor-install.ts`) is the only thing that touches `process`.
 */

describe('nodeFloorProblem', () => {
  test.each(['24.0.0', '24.13.3', '25.1.0', '100.0.0'])(
    'says nothing on Node %s — the runtime is new enough',
    (version) => {
      expect(nodeFloorProblem(version)).toBeUndefined()
    },
  )

  test.each(['23.11.0', '22.11.0', '20.9.0', '18.0.0'])(
    'refuses Node %s with one line that names both versions',
    (version) => {
      const problem = nodeFloorProblem(version)

      expect(problem).toBeDefined()
      expect(problem).toContain(String(MIN_NODE_MAJOR))
      expect(problem).toContain(version)
      expect(problem?.endsWith('\n')).toBe(true)
      // One line, so a client that surfaces only the first stderr line shows
      // the whole message.
      expect(problem?.trimEnd().includes('\n')).toBe(false)
    },
  )

  test.each(['', 'garbage', 'v', '.', 'x.y.z', 'v24'])(
    'says nothing about the unparseable version %s — a strange string must not block the CLI',
    (version) => {
      expect(nodeFloorProblem(version)).toBeUndefined()
    },
  )

  test('tolerates the leading v some runtimes report', () => {
    expect(nodeFloorProblem('v20.9.0')).toBeDefined()
    expect(nodeFloorProblem('v24.0.0')).toBeUndefined()
  })

  test('the floor is the one recorded in ADR-0006', () => {
    expect(MIN_NODE_MAJOR).toBe(24)
  })

  test('the message names the fix, not just the problem', () => {
    expect(nodeFloorProblem('20.9.0')).toContain('Install')
  })
})
