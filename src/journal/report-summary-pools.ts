import { ABSENT_VALUE, inlineValue } from './report-markdown.js'
import {
  childrenOutsideExport,
  type ReportChildBinding,
  type ReportPoolServerNote,
  type ReportPoolSession,
  type ReportPoolTally,
} from './report-pools.js'
import type { ReportOutsideLinks } from './report-pool-links.js'
import type { ReportManifest } from './report.js'

/**
 * The pool half of `summary.md` (ADR-0015, phase-5 amendment, R1-R4): the
 * "Pool sessions" section and the note on a child session's heading.
 *
 * Every value printed here was read back out of the journal and goes through
 * `inlineValue` -- both escapes of `report-markdown.ts`, in order. The ONLY
 * unescaped text is this module's own: the fixed labels and
 * {@link POOL_NAMING_NOTE}, whose code spans are markup this codebase wrote.
 *
 * `summary.md` is attested by `summary.sha256` but is prose: none of this
 * changes `report.json` or what `verify --report` re-derives (O1, ADR-0007).
 */

/**
 * What a pool session is, said once at the top of the section: how an auditor
 * gets from the name an agent called (`<server>__<tool>`) to the bare name a
 * child session's decision records. This codebase's own text -- NOT escaped.
 */
export const POOL_NAMING_NOTE =
  'A pool session is one agent connected at the pool address (`/mcp`). The plane answered it ' +
  'itself and opened one ordinary per-server session -- a child -- for each server the agent ' +
  'was granted, so every decision it led to is recorded by a child session, under the bare ' +
  'tool name that server published. The agent addressed that tool as `<server>__<tool>`: the ' +
  'prefix is the server name and nothing else (ADR-0015 §2, PE11). Every name in this section ' +
  'was read back from the journal.'

export interface PoolSectionInput {
  readonly pools: ReportPoolTally
  readonly manifest: Pick<ReportManifest, 'scope' | 'sessionIds' | 'records'>
  /** Pool sessions that attached the exported session, found OUTSIDE the export (D2). */
  readonly outside?: ReportOutsideLinks
}

/** Pool session ids a heading names before it only counts the rest (EX3). */
const MAX_HEADING_POOL_IDS = 8

/** Lifetimes worth naming on an attach: the held ones (ADR-0016, RS9). */
const HELD_LIFETIMES: ReadonlySet<string> = new Set(['warm', 'resident'])

/** The whole "Pool sessions" section, ending with a blank line. */
export function renderPoolSection(input: PoolSectionInput): readonly string[] {
  const { pools, manifest } = input
  const lines = ['## Pool sessions', '']
  const outside = input.outside
  const hasOutside = outside !== undefined && hasAnyOutside(outside)
  if (pools.sessions.length === 0) {
    lines.push(`This export holds no pool session records${hasOutside ? ' of its own' : ''}.`, '')
  } else {
    lines.push(POOL_NAMING_NOTE, '')
    const childrenNotExported = childrenOutsideExport(pools, manifest)
    for (const session of pools.sessions) {
      const isScoped = manifest.scope.session === session.sessionId
      lines.push(...sessionBlock(session, isScoped ? childrenNotExported : []))
    }
  }
  if (hasOutside && manifest.scope.session !== null) {
    lines.push(...outsideBlock(manifest.scope.session, outside, manifest.records.file))
  }
  if (pools.omittedRecordCount > 0) {
    lines.push(
      `${pools.omittedRecordCount} further pool record(s) are not reflected here (this summary keeps ` +
        'a bounded number of pool sessions and events). They are present in full in ' +
        `${manifest.records.file}.`,
      '',
    )
  }
  if (pools.unreadableCount > 0) {
    lines.push(
      `${pools.unreadableCount} pool record(s) could not be read; they are in ${manifest.records.file} verbatim.`,
      '',
    )
  }
  return lines
}

function sessionBlock(session: ReportPoolSession, outside: readonly string[]): readonly string[] {
  const agents = session.agentNames.map(inlineValue).join(', ')
  const lines = [
    `### Pool session ${inlineValue(session.sessionId)} — agent ${agents}`,
    '',
    `- Opened: ${instantText(session.openedAt, 'open')} · Closed: ${instantText(session.closedAt, 'close')}`,
    `- Attached (server → child session): ${attachedText(session)}`,
  ]
  if (session.refused.length > 0) lines.push(`- Did not attach: ${notesText(session.refused)}`)
  if (session.detached.length > 0) lines.push(`- Left the pool: ${notesText(session.detached)}`)
  const dropped = Object.entries(session.dropped)
  if (dropped.length > 0) {
    lines.push(
      `- Frames the pool refused: ${dropped.map(([reason, count]) => `${inlineValue(reason)} ×${count}`).join('; ')}`,
    )
  }
  if (outside.length > 0) {
    lines.push(
      `- Not in this export: child session(s) ${outside.map(inlineValue).join(', ')} — their ` +
        'decisions are recorded under those sessions. Export the whole journal (no --session) to ' +
        'include them.',
    )
  }
  lines.push('')
  return lines
}

function instantText(ts: string | undefined, event: 'open' | 'close'): string {
  return ts === undefined ? `no ${event} record in this export` : inlineValue(ts)
}

function attachedText(session: ReportPoolSession): string {
  if (session.children.length === 0) return '(none)'
  return session.children
    .map((child) => `${inlineValue(child.serverName)} → ${inlineValue(child.childSessionId)}${lifetimeText(child.lifetime)}`)
    .join('; ')
}

/** ` (resident)` or ` (warm)` for a held session; nothing for a pool's own child. */
function lifetimeText(lifetime: string | undefined): string {
  return lifetime !== undefined && HELD_LIFETIMES.has(lifetime) ? ` (${lifetime})` : ''
}

function hasAnyOutside(outside: ReportOutsideLinks): boolean {
  return outside.links.length > 0 || outside.omittedCount > 0 || outside.unreadableCount > 0 || outside.isScanCapped
}

/**
 * D2 (EX2): the pool sessions that attached a session exported ALONE, from
 * records this export does not hold — and a plain statement that nothing
 * about the export vouches for them.
 */
function outsideBlock(session: string, outside: ReportOutsideLinks, recordsFile: string): readonly string[] {
  const lines = [`### Pool membership of session ${inlineValue(session)} (from records outside this export)`, '']
  for (const link of outside.links) {
    lines.push(
      `- pool session ${inlineValue(link.poolSessionId)} — agent ${inlineValue(link.agentName)}, server ` +
        `${inlineValue(link.serverName)}, attached at ${inlineValue(link.attachedAt)} (record seq ${link.seq})` +
        lifetimeText(link.lifetime),
    )
  }
  if (outside.omittedCount > 0) lines.push(`- ${outside.omittedCount} further pool session(s) attached it; not listed.`)
  if (outside.unreadableCount > 0) lines.push(`- ${outside.unreadableCount} pool record(s) naming it could not be read.`)
  if (outside.isScanCapped) lines.push('- The lookup stopped early; there may be more.')
  lines.push(
    '',
    `These records are NOT in ${recordsFile}: neither its digest nor the chain covers them. To check ` +
      'them, export one of those pool sessions (`--session <pool session>`) or the whole journal.',
    '',
  )
  return lines
}

function notesText(notes: readonly ReportPoolServerNote[]): string {
  return notes
    .map((note) => `${inlineValue(note.serverName)} (${note.reason === undefined ? ABSENT_VALUE : inlineValue(note.reason)})`)
    .join('; ')
}

/**
 * The note appended to a child session's decision heading: which server and
 * pool session(s) it belongs to. Empty for a session no pool named.
 *
 * Several claims are the norm for a HELD session (ADR-0016, EX3): one process
 * of one agent's server, attached by that agent's pool sessions one after
 * another. Claims that disagree on the agent or the server are still a forgery
 * or a bug, and all of them are named rather than one picked. `outside` says
 * the claims were read from records this export does not hold (D2).
 */
export function childHeadingNote(
  bindings: readonly ReportChildBinding[] | undefined,
  options: { readonly outside?: boolean } = {},
): string {
  if (bindings === undefined || bindings.length === 0) return ''
  const where = options.outside === true ? '; from records outside this export' : ''
  const [first] = bindings
  if (first === undefined) return ''
  const agents = first.agentNames.map(inlineValue).join(', ')
  if (bindings.length === 1) {
    return ` — server ${inlineValue(first.serverName)}, pool session ${inlineValue(first.poolSessionId)} (agent ${agents}${where})`
  }
  if (bindings.every((binding) => isSameHolder(binding, first))) {
    const shown = bindings.slice(0, MAX_HEADING_POOL_IDS).map((binding) => inlineValue(binding.poolSessionId))
    const more = bindings.length > MAX_HEADING_POOL_IDS ? `, … (+${bindings.length - MAX_HEADING_POOL_IDS} more)` : ''
    return (
      ` — server ${inlineValue(first.serverName)}, agent ${agents}, attached by ${bindings.length} pool sessions: ` +
      `${shown.join(', ')}${more}${where}`
    )
  }
  const pools = bindings.map((binding) => inlineValue(binding.poolSessionId)).join(', ')
  return ` — claimed by ${bindings.length} pool sessions: ${pools}${where}`
}

/** One server, one and the same single agent: what repeated attaches of a held session look like. */
function isSameHolder(binding: ReportChildBinding, first: ReportChildBinding): boolean {
  return (
    binding.serverName === first.serverName &&
    binding.agentNames.length === 1 &&
    first.agentNames.length === 1 &&
    binding.agentNames[0] === first.agentNames[0]
  )
}
