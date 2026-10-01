import { randomBytes } from 'node:crypto'
import { replaceControlChars } from '../journal/format.js'
import { questionText } from './client-approval-text.js'

/**
 * Asks the person at the client to approve a held call (P2, ADR-0019): an MCP
 * form elicitation — in Claude Code a dialog "MCP server … requests your
 * input" with Accept / Decline — sent while the call waits in the approval
 * queue. The queue stays the one source of truth: an Accept or a Decline is
 * written into it in the client's name, and the gate's existing waiter picks
 * it up; anything else (Esc, an error, no answer, an answer too fast for a
 * person) leaves the call waiting there for `approvals approve|deny`.
 *
 * The questions use ids of mcpcut's own (`mcpcut-approval-<session nonce>-…`):
 * the client's answers to them are taken out of the stream here and never
 * reach the server, which never asked. Questions go one at a time — the next
 * dialog opens only after the last one is answered or withdrawn — so the
 * "too fast" clock starts close to when the person sees the dialog, even
 * with several calls held at once.
 */

export const CLIENT_APPROVAL_ID_PREFIX = 'mcpcut-approval-'

/**
 * Claude Code opens the dialog with Accept focused, so an Enter typed into
 * the prompt as it appears would approve. An Accept faster than this is not
 * taken as a decision: the question is asked once more, then left to the queue.
 */
export const MIN_HUMAN_ANSWER_MS = 1_000

/** Per session, so no server can guess or squat an id the proxy will take out of the stream. */
const ID_NONCE_BYTES = 6
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

/** The question on screen now. */
interface Shown {
  readonly id: string
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

export function createClientApprover(deps: ClientApprovalDeps): ClientApprover {
  const command = deps.command ?? 'mcpcut'
  const prefix = `${CLIENT_APPROVAL_ID_PREFIX}${randomBytes(ID_NONCE_BYTES).toString('hex')}-`
  let abilities: ClientAbilities | undefined
  let hasObservedInitialize = false
  let hasAnnounced = false
  let shown: Shown | undefined
  let isPumping = false
  const waiting: ApprovalQuestion[] = []

  function send(message: JsonObject): void {
    deps.send(message).catch(deps.onError)
  }

  /** Puts a question on screen; a failure to build it is reported and the call stays in the queue. */
  function show(question: ApprovalQuestion, round: number): void {
    try {
      const id = `${prefix}${question.approvalId}${round > 1 ? `-${round}` : ''}`
      const mode = abilities?.sendsMode === true ? { mode: 'form' } : {}
      const message = questionText(question, round, command)
      shown = { id, question, sentAtMs: deps.clock(), round }
      send({ jsonrpc: '2.0', id, method: ELICITATION_METHOD, params: { ...mode, message, requestedSchema: EMPTY_FORM } })
    } catch (error: unknown) {
      shown = undefined
      deps.onError(error)
    }
  }

  function announceOnce(): void {
    if (hasAnnounced) return
    hasAnnounced = true
    deps.onNotice?.(`Held calls are also asked in ${abilities?.name ?? 'the client'} (Accept / Decline). To keep approvals to the queue: "approval": { "askClient": false }\n`)
  }

  /** Shows the next waiting question once nothing is on screen; one at a time. */
  async function pump(): Promise<void> {
    if (isPumping) return
    isPumping = true
    try {
      while (shown === undefined && waiting.length > 0) {
        const next = waiting[0]
        if (next === undefined) break
        const allowed = deps.mayAsk === undefined || (await deps.mayAsk())
        // Withdrawn while the installation was being checked: go on with the new head.
        if (waiting[0] !== next || shown !== undefined) continue
        waiting.shift()
        if (!allowed) continue
        announceOnce()
        show(next, 1)
      }
    } finally {
      isPumping = false
    }
  }

  function next(): void {
    pump().catch(deps.onError)
  }

  function settle(question: ApprovalQuestion, outcome: ClientResolution['outcome']): void {
    const actor = `client:${abilities?.name ?? 'unknown'}`
    const reason = outcome === 'approved' ? 'accepted in the client' : 'declined in the client'
    deps.resolve(question.approvalId, { outcome, actor, reason }).catch(deps.onError)
  }

  function onAccept(entry: Shown): void {
    if (deps.clock() - entry.sentAtMs >= MIN_HUMAN_ANSWER_MS) {
      settle(entry.question, 'approved')
      return
    }
    if (entry.round === 1) {
      show(entry.question, 2)
      return
    }
    deps.onNotice?.(
      `An Accept for ${replaceControlChars(entry.question.toolName)} came too fast to be read twice; the call waits.\n` +
        `  Approve: ${command} approvals approve ${entry.question.approvalId}\n`,
    )
  }

  function takeResponse(response: { readonly id: unknown; readonly raw: string }): boolean {
    if (typeof response.id !== 'string' || !response.id.startsWith(prefix)) return false
    const entry = shown
    // An answer to a dialog already withdrawn or replaced: ours, so never forwarded, and it decides nothing.
    if (entry === undefined || entry.id !== response.id) return true
    shown = undefined
    const action = actionOf(response.raw)
    if (action === 'accept') onAccept(entry)
    if (action === 'decline') settle(entry.question, 'denied')
    next()
    return true
  }

  function withdraw(approvalId: string): void {
    const index = waiting.findIndex((question) => question.approvalId === approvalId)
    if (index >= 0) waiting.splice(index, 1)
    if (shown?.question.approvalId !== approvalId) return
    send({ jsonrpc: '2.0', method: CANCELLED_METHOD, params: { requestId: shown.id, reason: 'The call was settled outside this dialog.' } })
    shown = undefined
    next()
  }

  return {
    observeInitialize(raw) {
      // The first wins: a second initialize on one stdio session is a protocol violation, not a new client.
      if (hasObservedInitialize) return
      hasObservedInitialize = true
      abilities = abilitiesOf(raw)
    },
    takeResponse,
    ask(question) {
      if (abilities === undefined) return undefined
      waiting.push(question)
      next()
      return { withdraw: () => withdraw(question.approvalId) }
    },
  }
}
