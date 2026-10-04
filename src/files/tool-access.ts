import type { FileOp } from './constants.js'
import { TOOL_SPECS } from './tools.js'

/**
 * Which tool needs which right (ADR-0020 §1) — the ONE definition, read by
 * the handlers that run a tool and by the gate's argument check that refuses
 * it early, so the two cannot disagree.
 */

/** Tools that act on one `path` and need one fixed right on it. */
export const PATH_TOOL_OPS = {
  list_directory: 'read',
  get_file_info: 'read',
  read_file: 'read',
  create_directory: 'write',
  edit_file: 'edit',
  delete_file: 'delete',
} as const satisfies Readonly<Record<string, FileOp>>

/** `write_file` creates (write) or replaces (edit): decided by whether the path exists. */
export const WRITE_FILE_OPS = { create: 'write', replace: 'edit' } as const satisfies Readonly<Record<string, FileOp>>

/** `move_file` takes the entry away from one place and puts it in another. */
export const MOVE_FILE_OPS = { source: 'delete', destination: 'write' } as const satisfies Readonly<Record<string, FileOp>>

/** A right needed on one path; `create-or-replace` is settled once the path is resolved. */
export interface PathNeed {
  readonly raw: string
  readonly op: FileOp | 'create-or-replace'
}

type PathToolName = keyof typeof PATH_TOOL_OPS

function isPathTool(name: string): name is PathToolName {
  return Object.hasOwn(PATH_TOOL_OPS, name)
}

function needsOfParsed(name: string, args: Record<string, unknown>): readonly PathNeed[] {
  if (isPathTool(name)) return [{ raw: String(args['path']), op: PATH_TOOL_OPS[name] }]
  if (name === 'write_file') return [{ raw: String(args['path']), op: 'create-or-replace' }]
  if (name === 'move_file') {
    return [
      { raw: String(args['source']), op: MOVE_FILE_OPS.source },
      { raw: String(args['destination']), op: MOVE_FILE_OPS.destination },
    ]
  }
  return []
}

/**
 * The rights a call needs, or `undefined` when the call is not one the server
 * would run (unknown tool, arguments that fail the tool's schema): such a call
 * is the server's to refuse, with its own message.
 */
export function needsOf(name: string, rawArgs: unknown): readonly PathNeed[] | undefined {
  const spec = TOOL_SPECS.find((candidate) => candidate.name === name)
  if (spec === undefined) return undefined
  const parsed = spec.schema.safeParse(rawArgs ?? {})
  if (!parsed.success) return undefined
  return needsOfParsed(name, parsed.data as Record<string, unknown>)
}
