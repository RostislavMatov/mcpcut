import { replaceControlChars } from '../journal/format.js'
import { REDACTED_PLACEHOLDER } from '../config.js'
import { redact } from '../redact/redact.js'

/**
 * The words of the confirmation in the client (ADR-0019). The person confirms
 * what this text shows, so nothing is cut silently: arguments are shown field
 * by field, every field's name is shown, and a value or a list of fields that
 * does not fit says how much is hidden. Values pass through the redactor and
 * lose control characters — the agent chose them, and the dialog is drawn by
 * the client's terminal UI.
 */

const MAX_FIELDS = 12
const MAX_FIELD_NAME_CHARS = 40
const MAX_VALUE_CHARS = 160
/** A name long enough to push Decline and Esc out of the dialog is cut. */
const MAX_NAME_CHARS = 80

export interface QuestionText {
  readonly toolName: string
  readonly serverName: string
  readonly args: unknown
  /** An admin approves after this confirmation: Accept does not run the call yet. */
  readonly thenAdmin: boolean
}

function cut(text: string, max: number): { readonly text: string; readonly hidden: number } {
  return text.length > max ? { text: text.slice(0, max), hidden: text.length - max } : { text, hidden: 0 }
}

function valueLine(value: unknown): { readonly line: string; readonly isCut: boolean } {
  const shown = cut(replaceControlChars(JSON.stringify(value) ?? String(value)), MAX_VALUE_CHARS)
  return { line: shown.hidden > 0 ? `${shown.text}… (${shown.hidden} more characters)` : shown.text, isCut: shown.hidden > 0 }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ArgumentLines {
  readonly lines: readonly string[]
  /** Something was cut or left out. */
  readonly isCut: boolean
  /** Fields whose value the redactor hid, in whole or in part. */
  readonly hidden: readonly string[]
}

/** True when the redactor replaced some or all of this value. */
function isRedacted(value: unknown): boolean {
  return (JSON.stringify(value) ?? '').includes(REDACTED_PLACEHOLDER)
}

/**
 * The arguments as lines. Field names are quoted (JSON), so a key cannot pose
 * as a second field; a value the redactor hid is named, so the person never
 * accepts something they could not see (2026-10-02 security review).
 */
function argumentLines(args: unknown): ArgumentLines {
  const redacted = redact(args)
  if (!isRecord(redacted)) {
    const single = valueLine(redacted)
    return { lines: [`  ${single.line}`], isCut: single.isCut, hidden: isRedacted(redacted) ? ['(the value)'] : [] }
  }
  const entries = Object.entries(redacted)
  const shown = entries.slice(0, MAX_FIELDS).map(([name, value]) => {
    const field = cut(replaceControlChars(name), MAX_FIELD_NAME_CHARS)
    const quoted = JSON.stringify(`${field.text}${field.hidden > 0 ? '…' : ''}`)
    const rendered = valueLine(value)
    return { line: `  ${quoted}: ${rendered.line}`, isCut: rendered.isCut || field.hidden > 0, hidden: isRedacted(value) ? quoted : undefined }
  })
  const more = entries.length - shown.length
  const lines = [...shown.map((s) => s.line), ...(more > 0 ? [`  … and ${more} more fields`] : [])]
  const hidden = shown.flatMap((s) => (s.hidden !== undefined ? [s.hidden] : []))
  return { lines, isCut: more > 0 || shown.some((s) => s.isCut), hidden }
}

/** A name cut to fit, and whether it was. */
function nameOf(value: string): { readonly text: string; readonly isCut: boolean } {
  const shown = cut(replaceControlChars(value), MAX_NAME_CHARS)
  return { text: shown.hidden > 0 ? `${shown.text}…` : shown.text, isCut: shown.hidden > 0 }
}

export function questionText(question: QuestionText, round: number): string {
  const tool = nameOf(question.toolName)
  const server = nameOf(question.serverName)
  const again = round > 1 ? 'That Accept came too fast to be read, so it did not count. Press Accept again if you mean it.\n' : ''
  const args = argumentLines(question.args)
  const secrets = args.hidden.length > 0 ? `Hidden as secrets: ${args.hidden.join(', ')}.\n` : ''
  // Nothing waits in a queue yet, so there is no other place to read the call whole.
  const isPartial = args.isCut || args.hidden.length > 0 || tool.isCut || server.isCut
  const whole = isPartial ? 'Not everything is shown. Decline if you are not sure.\n' : ''
  const accept = question.thenAdmin ? 'Accept passes it on to an admin, who approves it too.' : 'Accept runs it now.'
  return (
    `${again}mcpcut: allow ${tool.text} on ${server.text}?\n${args.lines.join('\n')}\n${secrets}${whole}` +
    `${accept} Decline or Esc refuses it.`
  )
}
