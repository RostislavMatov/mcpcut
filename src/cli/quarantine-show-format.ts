import { formatReadableField } from '../journal/format.js'
import type { QuarantinedToolRecord } from '../policy/inventory-store.js'
import { diffToolSchemas, type SchemaChange } from '../policy/schema-diff.js'
import type { ToolDescriptor } from '../protocol/mcp.js'

/**
 * The plain-text rendering of `quarantine show` (extracted from
 * `quarantine-cmd.ts` when owner decision Q17 put an admin gate in front of
 * the mutating half and the command file reached this project's 400-line
 * cap).
 *
 * Mirrors `cardFor`/`renderCard` in `src/ui/pages/quarantine.ts`: same diff,
 * same fields, plain text instead of HTML. `quarantined.descriptor` and
 * `approvedDescriptor` are read back from the inventory store file --
 * untrusted, like every other field in this module -- so every string goes
 * through `formatReadableField` before it reaches the terminal.
 */

const SCHEMA_TRUNCATED_NOTE =
  'note: the stored schema was capped at write time (top-level summary only); the diff may be incomplete.'

export function formatQuarantineShow(
  serverName: string,
  toolName: string,
  quarantined: QuarantinedToolRecord,
  approvedDescriptor: ToolDescriptor | undefined,
): string {
  const header = formatShowHeader(serverName, toolName, quarantined)
  const body =
    approvedDescriptor === undefined
      ? formatNoBaseline(quarantined)
      : formatSchemaDiffSection(approvedDescriptor, quarantined)
  return `${[...header, '', ...body].join('\n')}\n`
}

function formatShowHeader(serverName: string, toolName: string, quarantined: QuarantinedToolRecord): string[] {
  const lines = [
    `server: ${formatReadableField(serverName)}`,
    `tool: ${formatReadableField(toolName)}`,
    `state: ${formatReadableField(quarantined.state)}`,
    `firstSeenAt: ${formatReadableField(quarantined.firstSeenAt)}`,
  ]
  if (quarantined.descriptor.description !== undefined) {
    lines.push(`description: "${formatReadableField(quarantined.descriptor.description)}"`)
  }
  return lines
}

/** No approved descriptor to diff against (new tool, or a pre-M4 approval with no stored descriptor). */
function formatNoBaseline(quarantined: QuarantinedToolRecord): string[] {
  const lines = [
    'no approved baseline for this tool -- nothing to diff against. Showing the observed descriptor:',
    `observed inputSchema: ${formatReadableField(safeStringify(quarantined.descriptor.inputSchema))}`,
  ]
  if (quarantined.schemaTruncated === true) lines.push(SCHEMA_TRUNCATED_NOTE)
  return lines
}

function formatSchemaDiffSection(approvedDescriptor: ToolDescriptor, quarantined: QuarantinedToolRecord): string[] {
  const diff = diffToolSchemas(approvedDescriptor.inputSchema, quarantined.descriptor.inputSchema)
  const surfaceDelta = quarantined.surfaceDelta ?? diff.surfaceDelta
  const lines = [`surfaceDelta: ${surfaceDelta}`, '', ...formatChangeList(diff.changes)]
  if (diff.truncated) lines.push('diff truncated (schema too deep/large; change list is incomplete)')
  if (quarantined.schemaTruncated === true) lines.push(SCHEMA_TRUNCATED_NOTE)
  return lines
}

function formatChangeList(changes: readonly SchemaChange[]): string[] {
  if (changes.length === 0) {
    return [
      'no structural change detected (description/annotation-only, or a hash mismatch without a schema difference)',
    ]
  }
  return ['changes:', ...changes.map((change) => `  ${change.kind}  ${formatReadableField(change.path)}`)]
}

/** `inputSchema` is untrusted, unknown-shaped JSON from the server; never throws. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return '<unserializable>'
  }
}
