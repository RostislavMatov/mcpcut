import { z } from 'zod'
import type { ToolDescriptor } from '../protocol/mcp.js'
import { MAX_PATH_LENGTH, MAX_WRITE_BYTES } from './constants.js'

/**
 * The file server's tool definitions (ADR-0020 §1): name, description, input
 * schema and the annotations mcpcut's policy classes are derived from
 * (`delete_file` is destructive by hint and by name; the write tools carry no
 * readOnlyHint, so they classify as write). Handlers live in `tool-handlers.ts`.
 */

const MAX_EDITS = 100
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/

const pathField = z.string().max(MAX_PATH_LENGTH)

const contentField = z
  .string()
  .refine((text) => Buffer.byteLength(text, 'utf8') <= MAX_WRITE_BYTES, {
    message: `content is larger than ${MAX_WRITE_BYTES / (1024 * 1024)} MiB: split it into smaller files`,
  })

const sha256Field = z.string().regex(SHA256_PATTERN, 'expectedSha256 must be 64 hex characters (the sha256 from read_file)')

export const noArgsSchema = z.strictObject({})
export const pathArgsSchema = z.strictObject({ path: pathField })
export const writeFileSchema = z.strictObject({ path: pathField, content: contentField, expectedSha256: sha256Field.optional() })
export const editFileSchema = z.strictObject({
  path: pathField,
  edits: z.array(z.strictObject({ oldText: z.string().min(1), newText: contentField })).min(1).max(MAX_EDITS),
  expectedSha256: sha256Field.optional(),
})
export const moveFileSchema = z.strictObject({ source: pathField, destination: pathField })

export type ToolAnnotations = {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
}

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly annotations: ToolAnnotations
  readonly schema: z.ZodType
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
const OVERWRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
const DESTROY: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false }

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'list_roots',
    description: 'List the folders you may work in and the operations (read, write, edit, delete) allowed in each. Call this first.',
    annotations: READ,
    schema: noArgsSchema,
  },
  {
    name: 'list_directory',
    description: 'List the files and folders inside a folder (absolute path), sorted by name.',
    annotations: READ,
    schema: pathArgsSchema,
  },
  {
    name: 'get_file_info',
    description: 'Get the kind, size, modification time and link count of a file or folder (absolute path).',
    annotations: READ,
    schema: pathArgsSchema,
  },
  {
    name: 'read_file',
    description: 'Read a text file (absolute path). Returns its text and sha256, which you can pass as expectedSha256 when you change it.',
    annotations: READ,
    schema: pathArgsSchema,
  },
  {
    name: 'write_file',
    description:
      'Create a text file, or replace an existing one (needs the edit right; pass expectedSha256 from read_file to avoid overwriting a concurrent change). The parent folder must exist.',
    annotations: OVERWRITE,
    schema: writeFileSchema,
  },
  {
    name: 'create_directory',
    description: 'Create a folder (absolute path) whose parent folder already exists.',
    annotations: WRITE,
    schema: pathArgsSchema,
  },
  {
    name: 'edit_file',
    description:
      'Replace exact text in a text file: every oldText must occur exactly once, and all edits apply or none. Pass expectedSha256 from read_file to guard against concurrent changes.',
    annotations: WRITE,
    schema: editFileSchema,
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or folder. Needs the delete right on the source and the write right on the destination.',
    annotations: WRITE,
    schema: moveFileSchema,
  },
  {
    name: 'delete_file',
    description: 'Delete a file or folder by moving it to the trash; only an administrator can restore it.',
    annotations: DESTROY,
    schema: pathArgsSchema,
  },
]

/** The `tools/list` entries: each schema published as plain JSON Schema (no `$schema` key). */
export function listedTools(): readonly ToolDescriptor[] {
  return TOOL_SPECS.map((spec) => {
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(spec.schema, { io: 'input' }) as Record<string, unknown>
    return { name: spec.name, description: spec.description, inputSchema, annotations: spec.annotations }
  })
}

/** One line naming the first problems of a failed validation, without echoing values. */
export function summarizeIssues(toolName: string, error: z.ZodError): string {
  const shown = error.issues.slice(0, 3).map((issue) => {
    const where = issue.path.length === 0 ? 'arguments' : issue.path.join('.')
    return `${where}: ${issue.message.replace(/\s+/g, ' ')}`
  })
  return `Invalid arguments for ${toolName} — ${shown.join('; ')}. Fix them and call again.`
}
