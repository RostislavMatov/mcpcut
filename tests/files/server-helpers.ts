import { createFilesServer, type FilesServer } from '../../src/files/server.js'
import { FILE_OPS, type FileOp } from '../../src/files/constants.js'
import type { FileRule } from '../../src/files/rights.js'
import { makeSandbox, type Sandbox } from './io-helpers.js'

/** A files server over a scratch root whose rules can be changed between calls. */
export interface Harness {
  readonly sandbox: Sandbox
  readonly server: FilesServer
  rules: readonly FileRule[]
  roots: readonly string[]
  failNextRoots: boolean
  call(name: string, args?: unknown): Promise<ToolResult>
  rpc(request: unknown): Promise<Record<string, unknown> | null>
}

export interface ToolResult {
  readonly text: string
  readonly isError: boolean
}

export const ALL_OPS: readonly FileOp[] = FILE_OPS

export async function makeHarness(ops: readonly FileOp[] = ALL_OPS): Promise<Harness> {
  const sandbox = await makeSandbox('server')
  const harness: Harness = {
    sandbox,
    rules: [{ path: sandbox.root, ops }],
    roots: [sandbox.root],
    failNextRoots: false,
    server: createFilesServer({
      roots: async () => {
        if (harness.failNextRoots) {
          harness.failNextRoots = false
          throw new Error('boom at /secret/stack')
        }
        return harness.roots
      },
      rules: async () => harness.rules,
      actor: 'tester',
    }),
    async rpc(request) {
      return (await harness.server.handle(request)) as Record<string, unknown> | null
    },
    async call(name, args) {
      const response = await harness.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      const result = response?.['result'] as { content: { type: string; text: string }[]; isError?: boolean }
      return { text: result.content[0]?.text ?? '', isError: result.isError === true }
    },
  }
  return harness
}
