import type { FileOp } from './constants.js'
import { TOOL_SPECS } from './tools.js'

/**
 * Which tool needs which right (ADR-0020 §1) — the ONE definition, read by
 * the handlers that run a tool and by the gate's argument check that refuses
 * it early, so the two cannot disagree.
 */

/** Tools that act on one `path` and the rights they need on it (every one of them). */
export const PATH_TOOL_OPS = {
  list_directory: ['read'],
  get_file_info: ['read'],
  read_file: ['read'],
  create_directory: ['write'],
  // Without `read`, the answers of an edit (found once / not found) would let an agent guess content.
  edit_file: ['read', 'edit'],
  delete_file: ['delete'],
} as const satisfies Readonly<Record<string, readonly FileOp[]>>

/**
 * `write_file` creates (write) or replaces (edit): decided by whether the path
 * exists. A replace that carries `expectedSha256` also needs `read`, because
 * the answer "stale or not" tells whether the guess about the content was right.
 */
export function writeFileOps(exists: boolean, isGuarded: boolean): readonly FileOp[] {
  if (!exists) return ['write']
  return isGuarded ? ['read', 'edit'] : ['edit']
}

/** `move_file` takes the entry away from one place and puts it in another. */
export const MOVE_FILE_OPS = { source: 'delete', destination: 'write' } as const satisfies Readonly<Record<string, FileOp>>

/** Rights of the destination that must also hold at the source: a move may not widen what the agent can see or change. */
export const MOVE_CARRIED_OPS = ['read', 'edit'] as const satisfies readonly FileOp[]

/**
 * A right needed on one path. `fixed` lists them; `write` settles once the
 * path is resolved; `isRemoved` marks a path whose whole folder goes away
 * (move source, delete target), so grants inside it must be checked too.
 */
export type PathNeed =
  | { readonly kind: 'fixed'; readonly raw: string; readonly ops: readonly FileOp[]; readonly isRemoved: boolean }
  | { readonly kind: 'write'; readonly raw: string; readonly isGuarded: boolean; readonly isRemoved: false }

/** The rights a need asks for at the resolved path. */
export function opsOfNeed(need: PathNeed, exists: boolean): readonly FileOp[] {
  return need.kind === 'fixed' ? need.ops : writeFileOps(exists, need.isGuarded)
}

type PathToolName = keyof typeof PATH_TOOL_OPS

function isPathTool(name: string): name is PathToolName {
  return Object.hasOwn(PATH_TOOL_OPS, name)
}

function needsOfParsed(name: string, args: Record<string, unknown>): readonly PathNeed[] {
  if (isPathTool(name)) {
    return [{ kind: 'fixed', raw: String(args['path']), ops: PATH_TOOL_OPS[name], isRemoved: name === 'delete_file' }]
  }
  if (name === 'write_file') {
    return [{ kind: 'write', raw: String(args['path']), isGuarded: args['expectedSha256'] !== undefined, isRemoved: false }]
  }
  if (name === 'move_file') {
    return [
      { kind: 'fixed', raw: String(args['source']), ops: [MOVE_FILE_OPS.source], isRemoved: true },
      { kind: 'fixed', raw: String(args['destination']), ops: [MOVE_FILE_OPS.destination], isRemoved: false },
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
