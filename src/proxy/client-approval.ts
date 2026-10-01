import { replaceControlChars } from '../journal/format.js'
import { redact } from '../redact/redact.js'

/**
 * Asks the person at the client to approve a held call (P2, ADR-0019): an MCP
 * form elicitation — in Claude Code a dialog "MCP server … requests your
 * input" with Accept / Decline — sent while the call waits in the approval
 * queue. The queue stays the one source of truth: an Accept or a Decline is
 * written into it in the client's name, and the gate's existing waiter picks
 * it up; anything else (Esc, an error, no answer, an answer too fast for a
 * person) leaves the call waiting there for `approvals approve|deny`.
 *
 * The questions use ids of mcpcut's own (`mcpcut-approval-…`): the client's
 * answers to them are taken out of the stream here and never reach the
 * server, which never asked.
 */

export const CLIENT_APPROVAL_ID_PREFIX = 'mcpcut-approval-'

/**
 * Claude Code opens the dialog with Accept focused, so an Enter typed into
 * the prompt as it appears would approve. An Accept faster than this is not
 * taken as a decision: the question is asked once more, then left to the queue.
 */
export const MIN_HUMAN_ANSWER_MS = 1_000

const MAX_ARGS_PREVIEW_CHARS = 300
const MAX_CLIENT_NAME_CHARS = 64
const CLIENT_NAME_UNSAFE = /[^A-Za-z0-9._-]+/g
const ELICITATION_METHOD = 'elicitation/create'
const CANCELLED_METHOD = 'notifications/cancelled'
const EMPTY_FORM = { type: 'object', properties: {}, required: [] } as const

export interface ApprovalQuestion {
  readonly approvalId: string
  /** Chosen by the agent; sanitized before it reaches the dialog. */
  readonly toolName: string
  readonly serverName: string
  readonly args: unknown
}

export interface ClientResolution {
  readonly outcome: 'approved' | 'denied'
  readonly actor: string
  readonly reason: string
}

/**
 * What the entry point decides about asking in the client: whether a person
 * there may approve at all — only while the installation has no admins, as
 * `approvals approve` needs no token only then — and how mcpcut is started.
 */
export interface AskClientOptions {
  readonly mayAsk: () => Promise<boolean>
  readonly command: string
}

export interface ClientApprovalDeps {
  /** Writes one message to the client (the same ordered writer the gate answers through). */
  readonly send: (message: Readonly<Record<string, unknown>>) => Promise<void>
  /** Resolves the pending approval in the queue; first resolution wins there. */
  readonly resolve: (approvalId: string, resolution: ClientResolution) => Promise<unknown>
  readonly clock: () => number
  /** Checked before each question; `false` asks nothing (an install with admins). */
  readonly mayAsk?: () => Promise<boolean>
  /** How mcpcut is started here (`mcpcut`, or the npx form), for the commands the text names. */
  readonly command?: string
  readonly onError: (error: unknown) => void
  /** Lines for the operator's terminal (the `wrap` stderr), never for the agent. */
  readonly onNotice?: (text: string) => void
}

export interface AskedQuestion {
  /** The call was settled another way (terminal, timeout): close the dialog. */
  withdraw(): void
}

export interface ClientApprover {
  /** Remembers what the client can do; called with each client `initialize` request. */
  observeInitialize(raw: string): void
  /** True for an answer to mcpcut's own question — the caller drops it instead of forwarding. */
  takeResponse(response: { readonly id: unknown; readonly raw: string }): boolean
  /** Asks the client, when it can show a form; `undefined` when it cannot. */
  ask(question: ApprovalQuestion): AskedQuestion | undefined
}

interface ClientAbilities {
  readonly name: string
  /** Clients of 2025-06-18 declare `elicitation: {}` and know no `mode`. */
  readonly sendsMode: boolean
}

interface Asked {
  readonly question: ApprovalQuestion
  readonly sentAtMs: number
  readonly round: number
}

type JsonObject = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function abilitiesOf(raw: string): ClientAbilities | undefined {
  const params = (parse(raw) as { params?: unknown } | undefined)?.params
  if (!isRecord(params) || !isRecord(params['capabilities'])) return undefined
  const elicitation = params['capabilities']['elicitation']
  if (!isRecord(elicitation)) return undefined
  const keys = Object.keys(elicitation)
  if (keys.length > 0 && !keys.includes('form')) return undefined
  const info = params['clientInfo']
  const rawName = isRecord(info) && typeof info['name'] === 'string' ? info['name'] : ''
  const name = rawName.replace(CLIENT_NAME_UNSAFE, '-').slice(0, MAX_CLIENT_NAME_CHARS) || 'unknown'
  return { name, sendsMode: keys.includes('form') }
}

function actionOf(raw: string): string | undefined {
  const result = (parse(raw) as { result?: unknown } | undefined)?.result
  return isRecord(result) && typeof result['action'] === 'string' ? result['action'] : undefined
}

function argsPreview(args: unknown): string {
  const text = replaceControlChars(JSON.stringify(redact(args)) ?? '')
  return text.length > MAX_ARGS_PREVIEW_CHARS ? `${text.slice(0, MAX_ARGS_PREVIEW_CHARS)}…` : text
}

export function createClientApprover(deps: ClientApprovalDeps): ClientApprover {
  const command = deps.command ?? 'mcpcut'
  let abilities: ClientAbilities | undefined
  const asked = new Map<string, Asked>()

  function messageOf(question: ApprovalQuestion, round: number): string {
    const tool = replaceControlChars(question.toolName)
    const server = replaceControlChars(question.serverName)
    const again = round > 1 ? 'That Accept came too fast to be read, so it did not count. Press Accept again if you mean it.\n' : ''
    return (
      `${again}mcpcut: allow ${tool} on ${server}?\n${argsPreview(question.args)}\n` +
      `Accept runs it now; Decline refuses it; Esc leaves it waiting in: ${command} approvals list`
    )
  }

  function idOf(question: ApprovalQuestion, round: number): string {
    return `${CLIENT_APPROVAL_ID_PREFIX}${question.approvalId}${round > 1 ? `-${round}` : ''}`
  }

  function send(message: JsonObject): void {
    deps.send(message).catch(deps.onError)
  }

  function sendQuestion(question: ApprovalQuestion, round: number): string {
    const id = idOf(question, round)
    const mode = abilities?.sendsMode === true ? { mode: 'form' } : {}
    asked.set(id, { question, sentAtMs: deps.clock(), round })
    send({ jsonrpc: '2.0', id, method: ELICITATION_METHOD, params: { ...mode, message: messageOf(question, round), requestedSchema: EMPTY_FORM } })
    return id
  }

  function settle(question: ApprovalQuestion, outcome: ClientResolution['outcome']): void {
    const actor = `client:${abilities?.name ?? 'unknown'}`
    const reason = outcome === 'approved' ? 'accepted in the client' : 'declined in the client'
    deps.resolve(question.approvalId, { outcome, actor, reason }).catch(deps.onError)
  }

  function tooFast(entry: Asked): void {
    if (entry.round === 1) {
      sendQuestion(entry.question, 2)
      return
    }
    deps.onNotice?.(
      `An Accept for ${replaceControlChars(entry.question.toolName)} came too fast to be read twice; the call waits.\n` +
        `  Approve: ${command} approvals approve ${entry.question.approvalId}\n`,
    )
  }

  function takeResponse(response: { readonly id: unknown; readonly raw: string }): boolean {
    if (typeof response.id !== 'string' || !response.id.startsWith(CLIENT_APPROVAL_ID_PREFIX)) return false
    const entry = asked.get(response.id)
    asked.delete(response.id)
    if (entry === undefined) return true
    const action = actionOf(response.raw)
    if (action === 'decline') settle(entry.question, 'denied')
    if (action !== 'accept') return true
    if (deps.clock() - entry.sentAtMs < MIN_HUMAN_ANSWER_MS) tooFast(entry)
    else settle(entry.question, 'approved')
    return true
  }

  function withdrawAll(approvalId: string): void {
    for (const [id, entry] of asked) {
      if (entry.question.approvalId !== approvalId) continue
      asked.delete(id)
      send({ jsonrpc: '2.0', method: CANCELLED_METHOD, params: { requestId: id, reason: 'The call was settled outside this dialog.' } })
    }
  }

  return {
    observeInitialize(raw) {
      abilities = abilitiesOf(raw)
    },
    takeResponse,
    ask(question) {
      if (abilities === undefined) return undefined
      let isWithdrawn = false
      const start = async (): Promise<void> => {
        if (deps.mayAsk !== undefined && !(await deps.mayAsk())) return
        if (!isWithdrawn) sendQuestion(question, 1)
      }
      start().catch(deps.onError)
      return {
        withdraw: () => {
          isWithdrawn = true
          withdrawAll(question.approvalId)
        },
      }
    },
  }
}
