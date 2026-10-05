import type { z } from 'zod'
import { FILE_OPS, type FileOp } from './constants.js'
import { fileInfo, listDirectory, readText } from './io-read.js'
import { moveToTrash } from './io-trash.js'
import { editFile, makeDirectory, moveEntry, replaceFile, writeNewFile } from './io-write.js'
import type { TrashManifest } from './trash-manifest.js'
import { resolveWithinRoots, type ResolvedPath } from './paths.js'
import { searchFilesTool } from './tool-search.js'
import { carriedMessage, carriedShortfall, innerGrantMessage, innerGrantOf } from './access-checks.js'
import { MOVE_FILE_OPS, PATH_TOOL_OPS, writeFileOps } from './tool-access.js'
import {
  authorize,
  errorOutput,
  fromIo,
  jsonOutput,
  requireOps,
  resolveFor,
  textOutput,
  type ToolContext,
  type ToolOutput,
} from './tool-context.js'
import {
  TOOL_SPECS,
  editFileSchema,
  moveFileSchema,
  pathArgsSchema,
  summarizeIssues,
  writeFileSchema,
} from './tools.js'

/*
 * Known limits, accepted (security review):
 *  - `write_file` answers "exists" (the right it needs differs), so an agent with write
 *    but not read can learn that a name is taken.
 *  - `list_directory` shows the names of children that a deeper rule carves out; only
 *    their content and operations are refused.
 *  - There is no quota: an agent with write can fill the disk (each write is capped at 10 MiB).
 *  - A crash between the trash rename and the manifest write leaves an orphan payload
 *    (see io-trash.ts).
 */

type Handler = (ctx: ToolContext, args: never) => Promise<ToolOutput>

const NO_FOLDERS_MESSAGE =
  'You have no folders yet. An administrator grants folders with `mcpcut files grant`; ask them, then call list_roots again.'

async function listRoots(ctx: ToolContext): Promise<ToolOutput> {
  if (!ctx.prepared.ok) return errorOutput(ctx.prepared.message)
  const granted = new Map<string, Set<FileOp>>()
  for (const rule of ctx.rules) {
    if (rule.ops.length === 0) continue
    const inside = await resolveWithinRoots(rule.path, ctx.roots)
    if (!inside.ok) continue
    granted.set(rule.path, new Set([...(granted.get(rule.path) ?? []), ...rule.ops]))
  }
  const folders = [...granted.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, ops]) => ({ path, ops: FILE_OPS.filter((op) => ops.has(op)) }))
  return folders.length === 0 ? textOutput(NO_FOLDERS_MESSAGE) : jsonOutput({ folders })
}

async function onPath(ctx: ToolContext, raw: string, ops: readonly FileOp[], run: (target: ResolvedPath) => Promise<ToolOutput>): Promise<ToolOutput> {
  const access = await authorize(ctx, raw, ops)
  return access.ok ? run(access.value) : access.output
}

async function writeFileTool(ctx: ToolContext, args: z.output<typeof writeFileSchema>): Promise<ToolOutput> {
  const resolved = await resolveFor(ctx, args.path)
  if (!resolved.ok) return resolved.output
  const refusal = requireOps(ctx, resolved.value, args.path, writeFileOps(resolved.value.exists, args.expectedSha256 !== undefined))
  if (refusal !== null) return refusal
  const written = resolved.value.exists
    ? await replaceFile(resolved.value, args.content, args.expectedSha256)
    : await writeNewFile(resolved.value, args.content)
  return fromIo(written, (info) => jsonOutput({ path: args.path, size: info.size, sha256: info.sha256 }))
}

async function moveFileTool(ctx: ToolContext, args: z.output<typeof moveFileSchema>): Promise<ToolOutput> {
  const source = await resolveFor(ctx, args.source)
  if (!source.ok) return source.output
  const destination = await resolveFor(ctx, args.destination)
  if (!destination.ok) return destination.output
  const refusal = requireOps(ctx, source.value, args.source, [MOVE_FILE_OPS.source]) ??
    requireOps(ctx, destination.value, args.destination, [MOVE_FILE_OPS.destination])
  if (refusal !== null) return refusal
  const carried = carriedShortfall(ctx, source.value, destination.value)
  if (carried !== null) return errorOutput(carriedMessage(carried, args.source, args.destination))
  const inner = await innerGrantOf(ctx, source.value)
  if (inner !== null) return errorOutput(innerGrantMessage(args.source, inner))
  return fromIo(await moveEntry(source.value, destination.value), () => textOutput(`Moved ${args.source} to ${args.destination}.`))
}

async function deleteFileTool(ctx: ToolContext, args: z.output<typeof pathArgsSchema>): Promise<ToolOutput> {
  return onPath(ctx, args.path, PATH_TOOL_OPS.delete_file, async (target) => {
    const inner = await innerGrantOf(ctx, target)
    if (inner !== null) return errorOutput(innerGrantMessage(args.path, inner))
    return fromIo(await moveToTrash(target, ctx.actor), (manifest) => textOutput(trashedText(args.path, manifest)))
  })
}

// The text names no root: it could lie above the folder the agent was granted, and the restore command is shown to administrators in the CLI.
const trashedText = (path: string, manifest: TrashManifest): string =>
  `Moved ${path} to the trash (id ${manifest.id}). It is not deleted for good: an administrator can restore it by that id.`

const HANDLERS: Readonly<Record<string, Handler>> = {
  list_roots: listRoots,
  list_directory: (ctx: ToolContext, args: z.output<typeof pathArgsSchema>) =>
    onPath(ctx, args.path, PATH_TOOL_OPS.list_directory, async (target) => fromIo(await listDirectory(target), jsonOutput)),
  get_file_info: (ctx: ToolContext, args: z.output<typeof pathArgsSchema>) =>
    onPath(ctx, args.path, PATH_TOOL_OPS.get_file_info, async (target) => fromIo(await fileInfo(target), jsonOutput)),
  read_file: (ctx: ToolContext, args: z.output<typeof pathArgsSchema>) =>
    onPath(ctx, args.path, PATH_TOOL_OPS.read_file, async (target) => fromIo(await readText(target), jsonOutput)),
  write_file: writeFileTool,
  create_directory: (ctx: ToolContext, args: z.output<typeof pathArgsSchema>) =>
    onPath(ctx, args.path, PATH_TOOL_OPS.create_directory, async (target) =>
      fromIo(await makeDirectory(target), () => textOutput(`Created the folder ${args.path}.`)),
    ),
  edit_file: (ctx: ToolContext, args: z.output<typeof editFileSchema>) =>
    onPath(ctx, args.path, PATH_TOOL_OPS.edit_file, async (target) =>
      fromIo(await editFile(target, args.edits, args.expectedSha256), (info) => jsonOutput({ path: args.path, size: info.size, sha256: info.sha256 })),
    ),
  move_file: moveFileTool,
  delete_file: deleteFileTool,
  search_files: searchFilesTool,
}

/** True when the file server has a tool of that name. */
export function hasTool(name: string): boolean {
  return Object.hasOwn(HANDLERS, name)
}

/** Validates the arguments against the tool's schema, then runs it; a bad argument is a one-line tool error. */
export async function runTool(name: string, ctx: ToolContext, rawArgs: unknown): Promise<ToolOutput> {
  const spec = TOOL_SPECS.find((candidate) => candidate.name === name)
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined
  if (spec === undefined || handler === undefined) {
    return errorOutput(`Unknown tool ${name}: call tools/list to see the available tools.`)
  }
  const parsed = spec.schema.safeParse(rawArgs ?? {})
  if (!parsed.success) return errorOutput(summarizeIssues(name, parsed.error))
  return handler(ctx, parsed.data as never)
}
