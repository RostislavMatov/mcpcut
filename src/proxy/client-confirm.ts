import { randomBytes } from 'node:crypto'
import { questionText } from './client-confirm-text.js'

/**
 * Asks the person at the client to confirm a tool call (ADR-0019): an MCP
 * form elicitation — in Claude Code a dialog "MCP server … requests your
 * input" with Accept / Decline. The confirmation is a rule of its own
 * (`confirmInClient`), never a way to answer the admin's approval queue: this
 * module only reports what the person did, and the gate decides what that
 * means for the call.
 *
 * The questions use ids of mcpcut's own (`mcpcut-confirm-<session nonce>-…`):
 * the client's answers to them are taken out of the stream here and never
 * reach the server, which never asked. Questions go one at a time — the next
 * dialog opens only after the last one is answered or withdrawn — so the
 * "too fast" clock starts close to when the person sees the dialog, even
 * with several calls waiting at once.
 */

export const CLIENT_CONFIRM_ID_PREFIX = 'mcpcut-confirm-'

/**
 * Claude Code opens the dialog with Accept focused, so an Enter typed into
 * the prompt as it appears would accept. An Accept faster than this is not
 * taken as a decision: the question is asked once more, and a second one as
 * fast is reported as `too-fast`.
 */
export const MIN_HUMAN_ANSWER_MS = 1_000

/** Per session, so no server can guess or squat an id the proxy will take out of the stream. */
const ID_NONCE_BYTES = 6
const MAX_CLIENT_NAME_CHARS = 64
const CLIENT_NAME_UNSAFE = /[^A-Za-z0-9._-]+/g
const ELICITATION_METHOD = 'elicitation/create'
const CANCELLED_METHOD = 'notifications/cancelled'
const EMPTY_FORM = { type: 'object', properties: {}, required: [] } as const
const ACCEPT_ROUNDS = 2

export interface ConfirmQuestion {
  /** Chosen by the agent; sanitized before it reaches the dialog. */
  readonly toolName: string
  readonly serverName: string
  readonly args: unknown
  /** An admin approves after this confirmation (the text says Accept does not run it yet). */
  readonly thenAdmin: boolean
}

/**
 * What became of one question. `actor` (`client:<name>`) is present where the
 * person answered; `too-fast`, `failed` and `withdrawn` name nobody, as no
 * person decided anything.
 */
export type ConfirmAnswer =
  | { readonly kind: 'accepted'; readonly actor: string }
  | { readonly kind: 'declined'; readonly actor: string }
  | { readonly kind: 'cancelled'; readonly actor: string }
  | { readonly kind: 'too-fast' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'withdrawn' }

export interface ClientConfirmDeps {
  /** Writes one message to the client (the same ordered writer the gate answers through). */
  readonly send: (message: Readonly<Record<string, unknown>>) => Promise<void>
  readonly clock: () => number
  readonly onError: (error: unknown) => void
}

export interface PendingConfirmation {
  /** Settles exactly once; never rejects. */
  readonly answer: Promise<ConfirmAnswer>
  /** The call was settled another way (timeout, session end): close the dialog, answer `withdrawn`. */
  withdraw(): void
}

export interface ClientConfirmer {
  /** Remembers what the client can do; called with each client `initialize` request. */
  observeInitialize(raw: string): void
  /** True for an answer to mcpcut's own question — the caller drops it instead of forwarding. */
  takeResponse(response: { readonly id: unknown; readonly raw: string }): boolean
  /** True once the client's `initialize` said it can show a form. */
  canConfirm(): boolean
  /** The client's name from its `initialize`, made safe for a journal field. */
  clientName(): string | undefined
  /** Asks the client, when it can show a form; `undefined` when it cannot. */
  confirm(question: ConfirmQuestion): PendingConfirmation | undefined
  /** Answers every open and waiting question `withdrawn` (session end). */
  withdrawAll(): void
}

interface ClientAbilities {
  readonly name: string
  /** Clients of 2025-06-18 declare `elicitation: {}` and know no `mode`. */
  readonly sendsMode: boolean
}

/** One call's confirmation, from `confirm` until it is answered. */
interface Entry {
  readonly n: number
  readonly question: ConfirmQuestion
  readonly settle: (answer: ConfirmAnswer) => void
}

/** The question on screen now. */
interface Shown {
  readonly id: string
  readonly entry: Entry
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

/** The person's action, or `undefined` for an error response or anything malformed. */
function actionOf(raw: string): string | undefined {
  const result = (parse(raw) as { result?: unknown } | undefined)?.result
  return isRecord(result) && typeof result['action'] === 'string' ? result['action'] : undefined
}

export function createClientConfirmer(deps: ClientConfirmDeps): ClientConfirmer {
  const prefix = `${CLIENT_CONFIRM_ID_PREFIX}${randomBytes(ID_NONCE_BYTES).toString('hex')}-`
  let abilities: ClientAbilities | undefined
  let hasObservedInitialize = false
  let shown: Shown | undefined
  let count = 0
  const waiting: Entry[] = []

  function actor(): string {
    return `client:${abilities?.name ?? 'unknown'}`
  }

  /** Puts a question on screen; a question that cannot be sent is answered `failed`. */
  function show(entry: Entry, round: number): void {
    const id = `${prefix}${entry.n}${round > 1 ? `-${round}` : ''}`
    const mode = abilities?.sendsMode === true ? { mode: 'form' } : {}
    const current: Shown = { id, entry, sentAtMs: deps.clock(), round }
    shown = current
    // A send that throws before it returns a promise fails the same way as one
    // that rejects: either way the dialog never reached the client.
    Promise.resolve()
      .then(() => {
        const params = { ...mode, message: questionText(entry.question, round), requestedSchema: EMPTY_FORM }
        return deps.send({ jsonrpc: '2.0', id, method: ELICITATION_METHOD, params })
      })
      .catch((error: unknown) => {
        deps.onError(error)
        if (shown !== current) return
        shown = undefined
        entry.settle({ kind: 'failed' })
        next()
      })
  }

  /** Shows the next waiting question once nothing is on screen; one at a time. */
  function next(): void {
    if (shown !== undefined) return
    const head = waiting.shift()
    if (head !== undefined) show(head, 1)
  }

  function onAccept(current: Shown): void {
    if (deps.clock() - current.sentAtMs >= MIN_HUMAN_ANSWER_MS) {
      current.entry.settle({ kind: 'accepted', actor: actor() })
      return
    }
    if (current.round < ACCEPT_ROUNDS) {
      show(current.entry, current.round + 1)
      return
    }
    current.entry.settle({ kind: 'too-fast' })
  }

  function answer(current: Shown, action: string | undefined): void {
    if (action === 'accept') return onAccept(current)
    if (action === 'decline') return current.entry.settle({ kind: 'declined', actor: actor() })
    if (action === 'cancel') return current.entry.settle({ kind: 'cancelled', actor: actor() })
    current.entry.settle({ kind: 'failed' })
  }

  function takeResponse(response: { readonly id: unknown; readonly raw: string }): boolean {
    if (typeof response.id !== 'string' || !response.id.startsWith(prefix)) return false
    const current = shown
    // An answer to a dialog already withdrawn or replaced: ours, so never forwarded, and it decides nothing.
    if (current === undefined || current.id !== response.id) return true
    shown = undefined
    answer(current, actionOf(response.raw))
    next()
    return true
  }

  function withdraw(entry: Entry): void {
    const index = waiting.indexOf(entry)
    if (index >= 0) waiting.splice(index, 1)
    if (shown?.entry === entry) {
      const requestId = shown.id
      Promise.resolve()
        .then(() => deps.send({ jsonrpc: '2.0', method: CANCELLED_METHOD, params: { requestId, reason: 'The call was settled outside this dialog.' } }))
        .catch(deps.onError)
      shown = undefined
    }
    entry.settle({ kind: 'withdrawn' })
    next()
  }

  function confirm(question: ConfirmQuestion): PendingConfirmation | undefined {
    if (abilities === undefined) return undefined
    count += 1
    let settled = false
    let settleAnswer: (value: ConfirmAnswer) => void = () => undefined
    const answerPromise = new Promise<ConfirmAnswer>((resolve) => {
      settleAnswer = resolve
    })
    const entry: Entry = {
      n: count,
      question,
      settle: (value) => {
        if (settled) return
        settled = true
        settleAnswer(value)
      },
    }
    waiting.push(entry)
    next()
    return { answer: answerPromise, withdraw: () => (settled ? undefined : withdraw(entry)) }
  }

  return {
    observeInitialize(raw) {
      // The first wins: a second initialize on one stdio session is a protocol violation, not a new client.
      if (hasObservedInitialize) return
      hasObservedInitialize = true
      abilities = abilitiesOf(raw)
    },
    takeResponse,
    canConfirm: () => abilities !== undefined,
    clientName: () => abilities?.name,
    confirm,
    withdrawAll() {
      // The waiting ones first: withdrawing the one on screen shows the next.
      for (const entry of waiting.splice(0)) entry.settle({ kind: 'withdrawn' })
      if (shown !== undefined) withdraw(shown.entry)
    },
  }
}
