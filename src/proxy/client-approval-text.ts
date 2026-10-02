import { replaceControlChars } from '../journal/format.js'
import { redact } from '../redact/redact.js'

/**
 * The words of the in-client approval question (P2, ADR-0019). The person
 * approves what this text shows, so nothing is cut silently: arguments are
 * shown field by field, every field's name is shown, and a value or a list
 * of fields that does not fit says how much is hidden and where to read it
 * whole. Values pass through the redactor and lose control characters — the
 * agent chose them, and the dialog is drawn by the client's terminal UI.
 */

const MAX_FIELDS = 12
const MAX_FIELD_NAME_CHARS = 40
const MAX_VALUE_CHARS = 160
/** A name long enough to push Decline and Esc out of the dialog is cut. */
const MAX_NAME_CHARS = 80

export interface QuestionText {
  readonly toolName: string
  readonly serverName: string
  readonly approvalId: string
  readonly args: unknown
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

/** The arguments as lines, and whether anything was left out. */
function argumentLines(args: unknown): { readonly lines: readonly string[]; readonly isCut: boolean } {
  const redacted = redact(args)
  if (!isRecord(redacted)) {
    const single = valueLine(redacted)
    return { lines: [`  ${single.line}`], isCut: single.isCut }
  }
  const entries = Object.entries(redacted)
  const shown = entries.slice(0, MAX_FIELDS).map(([name, value]) => {
    const field = cut(replaceControlChars(name), MAX_FIELD_NAME_CHARS)
    const rendered = valueLine(value)
    return { line: `  ${field.text}${field.hidden > 0 ? '…' : ''}: ${rendered.line}`, isCut: rendered.isCut || field.hidden > 0 }
  })
  const more = entries.length - shown.length
  const lines = [...shown.map((s) => s.line), ...(more > 0 ? [`  … and ${more} more fields`] : [])]
  return { lines, isCut: more > 0 || shown.some((s) => s.isCut) }
}

export function questionText(question: QuestionText, round: number, command: string): string {
  const name = (value: string): string => {
    const shown = cut(replaceControlChars(value), MAX_NAME_CHARS)
    return shown.hidden > 0 ? `${shown.text}…` : shown.text
  }
  const tool = name(question.toolName)
  const server = name(question.serverName)
  const again = round > 1 ? 'That Accept came too fast to be read, so it did not count. Press Accept again if you mean it.\n' : ''
  const args = argumentLines(question.args)
  const whole = args.isCut ? `Not everything is shown. Read it whole: ${command} approvals list --json\n` : ''
  return (
    `${again}mcpcut: allow ${tool} on ${server}?\n${args.lines.join('\n')}\n${whole}` +
    `Accept runs it now; Decline refuses it; Esc leaves it waiting in: ${command} approvals list`
  )
}
