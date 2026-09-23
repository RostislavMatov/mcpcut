import { classify, type ClassifiedMessage, type JsonRpcId } from '../protocol/classify.js'
import {
  CANCELLED_NOTIFICATION,
  INITIALIZE_METHOD,
  INITIALIZED_NOTIFICATION,
  PING_METHOD,
  PROMPTS_GET_METHOD,
  PROMPTS_LIST_CHANGED_NOTIFICATION,
  PROMPTS_LIST_METHOD,
  TOOLS_CALL_METHOD,
  TOOLS_LIST_CHANGED_NOTIFICATION,
  TOOLS_LIST_METHOD,
} from '../protocol/mcp.js'
import type { SynthesizableId } from '../proxy/synthesize.js'
import { clientMessage, type McpMessage } from '../transport/message.js'
import {
  cancelledRequestIdOf,
  emptyListFrame,
  hasCursor,
  LIST_KIND_BY_METHOD_NAME,
  notificationFrame,
  poolNameOf,
  progressTokenOfRequest,
  refusalFor,
} from './multiplexer-frames.js'
import type { PoolRecordInfo } from '../journal/pool-record.js'
import type { PoolCatalog } from './catalog.js'
import { createChildFrameHandler } from './child-frames.js'
import { POOL_DEPARTURE_IN_FLIGHT_AT_CLOSE, POOL_DEPARTURE_UNGRANTED } from './constants.js'
import type { PoolChildren } from './children.js'
import type { PoolCorrelator } from './correlator.js'
import type { PoolFanout } from './fanout.js'
import {
  poolCursorError,
  poolMemberGoneError,
  poolMethodNotFoundError,
  poolPingResult,
} from './errors.js'
import { readRequestedVersion, synthesizeInitializeResult } from './initialize.js'
import type { PoolListKind } from './merge-lists.js'
import { routePoolRequest, unknownTargetError } from './route-request.js'
import type { PoolWatch } from './watch.js'

/**
 * The multiplexer: one agent's frames in, N child sessions' frames out, and
 * back (ADR-0015 §§3-5). Everything it needs to DO is injected — it opens no
 * session, reads no registry and writes no file — so what remains here is the
 * dispatch itself, which is the part worth reading in one piece.
 *
 * Three rules hold the whole thing together:
 *
 *  - Client ids are never rewritten. The agent has one id space and each of
 *    its calls goes to exactly one upstream; the correlator enforces that a
 *    reply can only settle the request it belongs to, at the server it was
 *    sent to.
 *  - Exactly one outcome reaches the agent per id. A frame the pool refuses
 *    is answered with a synthesized error, never dropped silently — unless it
 *    carries no id to answer, in which case the drop itself is journaled.
 *  - Nothing here throws into the traffic path. A failure is a dropped frame
 *    plus a report, because a multiplexer that dies takes every one of the
 *    agent's servers with it.
 */

export interface PoolMultiplexerDeps {
  readonly agentName: string
  /** The plane's own version, for `serverInfo`; there is no version literal under `src/`. */
  readonly planeVersion: string
  readonly children: PoolChildren
  readonly catalog: PoolCatalog
  readonly correlator: PoolCorrelator
  /** Settles the replies to the plane's OWN upstream requests (`fanout.ts`). */
  readonly fanout: PoolFanout
  readonly watch: PoolWatch
  /** One `kind:'pool'` record. Wrapped by the caller; guarded again here. */
  readonly journal: (info: PoolRecordInfo) => void
  /** Everything the pool sends the agent (already framed). */
  readonly toAgent: (bytes: Buffer) => void
  readonly onError: (error: unknown) => void
}

export interface PoolMultiplexer {
  /** One frame from the agent. Never throws. */
  handleAgentFrame(bytes: Buffer): void
  /** One frame from a child session. Never throws. */
  handleChildFrame(server: string, message: McpMessage): void
  /**
   * A child left the pool, for ANY reason — ungranted, its own session ended,
   * or it stopped answering. Answers every call the agent had in flight there
   * and forgets them. Idempotent, and must be called on every departure: see
   * its implementation for what goes wrong when one path forgets.
   */
  releaseServer(server: string): void
  /** Called by the watch when membership moved; closes what left, wakes the agent. */
  onMembershipChanged(granted: readonly string[]): Promise<void>
  close(): Promise<void>
}

/** The byte a line-framed message ends with; stripped before a payload is sent. */
const NEWLINE_BYTE = 0x0a

/** The two list methods a pool answers by fanning out. */
const LIST_KIND_BY_METHOD: Readonly<Record<string, PoolListKind>> = {
  [TOOLS_LIST_METHOD]: 'tools',
  [PROMPTS_LIST_METHOD]: 'prompts',
}

/** The two methods whose `params.name` carries a `<server>__<name>` prefix. */
const ADDRESSED_METHODS: ReadonlySet<string> = new Set([TOOLS_CALL_METHOD, PROMPTS_GET_METHOD])

export function createPoolMultiplexer(deps: PoolMultiplexerDeps): PoolMultiplexer {
  let isClosed = false

  /** Journaling must never be able to kill traffic; guarded on both sides. */
  function record(info: Omit<PoolRecordInfo, 'agentName'>): void {
    try {
      deps.journal({ agentName: deps.agentName, ...info })
    } catch (error: unknown) {
      deps.onError(error)
    }
  }

  /**
   * Hands one frame to the agent, WITHOUT its trailing newline.
   *
   * Framing belongs to the transport (`transport/message.ts`), and the message
   * the pool produces here is a payload, not a wire write. Several of the
   * synthesizers this module calls are shared with the stdio proxy and append
   * a newline for that wire (`proxy/synthesize.ts`); a message carrying one
   * cannot be line-framed for a stdio client at all, so a bridged agent saw
   * NOTHING rather than a malformed line — the loudest possible failure hiding
   * behind the quietest symptom. Normalized in one place, here, rather than
   * asking every producer to remember.
   */
  function send(bytes: Buffer): void {
    const line = bytes.at(-1) === NEWLINE_BYTE ? bytes.subarray(0, -1) : bytes
    try {
      deps.toAgent(line)
    } catch (error: unknown) {
      deps.onError(error)
    }
  }

  // The child side of the dispatch (`child-frames.ts`), built once.
  const handleChildFrame = createChildFrameHandler({
    correlator: deps.correlator,
    fanout: deps.fanout,
    send,
    record,
    onError: deps.onError,
    isClosed: () => isClosed,
  })

  /**
   * The id a synthesized reply can be addressed to, or `null`. `null` excludes
   * itself: a request with a `null` id has no return address, so such a frame
   * is dropped with a record — exactly what the gate already does.
   */
  function answerableId(id: JsonRpcId): SynthesizableId | null {
    return id === null ? null : id
  }

  async function handleList(id: SynthesizableId, raw: string, kind: PoolListKind): Promise<void> {
    if (hasCursor(raw)) {
      // P6: the pool drains its upstreams' pages itself and hands out no
      // cursor, so a cursor here is confusion or forgery.
      send(poolCursorError(id))
      record({ event: 'dropped', reason: 'unsupported-method', method: LIST_KIND_BY_METHOD_NAME[kind] })
      return
    }
    // PE7: THIS is where children come up, not `initialize` and not the watch.
    await deps.children.ensure(deps.watch.granted)
    const merged = await deps.catalog.build(id, kind)
    if (merged === null) {
      // Unreachable with today's callers (`JSON.stringify` escapes newlines),
      // kept because a corrupted frame is worse than an empty list.
      send(emptyListFrame(id, kind))
      record({ event: 'dropped', reason: 'unreadable', method: LIST_KIND_BY_METHOD_NAME[kind] })
      return
    }
    send(Buffer.from(merged.serialized, 'utf8'))
    if (merged.hidden.length > 0 || merged.warned.length > 0) {
      // PE2: a name too long for known clients is hidden rather than listed,
      // because ONE invalid name breaks the agent's whole request. It stays
      // reachable through its per-server address, and the operator learns
      // which names those were from here.
      record({
        event: 'dropped',
        reason: 'name-too-long',
        method: LIST_KIND_BY_METHOD_NAME[kind],
        ...(merged.hidden.length > 0 ? { hiddenNames: merged.hidden.map(poolNameOf) } : {}),
        ...(merged.warned.length > 0 ? { warnedNames: merged.warned.map(poolNameOf) } : {}),
      })
    }
  }

  function handleAddressed(id: SynthesizableId, raw: string, method: string): void {
    const routed = routePoolRequest(raw, (server) => deps.children.childOf(server) !== undefined)
    if (routed === null || routed.kind === 'not-addressed') {
      send(poolMethodNotFoundError(id, method))
      record({ event: 'dropped', reason: 'unreadable', method })
      return
    }
    if (routed.kind === 'unknown-target') {
      send(unknownTargetError(id, routed.poolName))
      record({ event: 'dropped', reason: 'unknown-target', method })
      return
    }

    // Looked up BEFORE the request is tracked, so no path here ever has to
    // un-track an id — `routePoolRequest` already asked the same question, and
    // nothing awaits in between, so this is belt to that braces.
    const child = deps.children.childOf(routed.server)
    if (child === undefined) {
      send(poolMemberGoneError(id, routed.server))
      record({ event: 'dropped', serverName: routed.server, reason: 'unknown-target', method })
      return
    }

    // The token is read from the AGENT's own frame: it is the agent's to give,
    // and the entry that holds it is the only thing that lets progress on it
    // through (`child-frames.ts`, ADR-0015 phase 5 N2).
    const tracked = deps.correlator.trackClient(id, routed.server, progressTokenOfRequest(raw) ?? undefined)
    if (!tracked.ok) {
      // The pool answers THIS request rather than accepting an id it could
      // not settle. Each reason gets its own code, because they send the
      // agent to different remedies: a fresh id, a retry, or a new id space.
      send(refusalFor(tracked.reason, id))
      record({ event: 'dropped', serverName: routed.server, reason: tracked.reason, method })
      return
    }

    // The prefix is stripped BEFORE the child sees the frame, which is what
    // keeps policy, quarantine, approvals and the journal reading the bare
    // name with no change of their own (PE11).
    void child.sink
      .write(clientMessage(Buffer.from(routed.serialized, 'utf8')))
      .catch((error: unknown) => {
        deps.onError(error)
        // The frame never left, so the id just tracked would wait for an
        // answer nobody is going to send. Settle it here and tell the agent.
        if (deps.correlator.settle(routed.server, id).kind === 'client') {
          send(poolMemberGoneError(id, routed.server))
        }
        record({ event: 'dropped', serverName: routed.server, reason: 'unreadable', method })
      })
  }

  function dispatchRequest(id: JsonRpcId, method: string, raw: string): void {
    if (method === INITIALIZE_METHOD) {
      const answerable = answerableId(id)
      if (answerable === null) {
        record({ event: 'dropped', reason: 'unreadable', method })
        return
      }
      // PE12: the plane is the server at this address. No child comes up here
      // — that is `tools/list`'s job (PE7).
      send(synthesizeInitializeResult(answerable, readRequestedVersion(raw), deps.planeVersion))
      return
    }

    const answerable = answerableId(id)
    if (answerable === null) {
      record({ event: 'dropped', reason: 'unreadable', method })
      return
    }
    if (method === PING_METHOD) {
      send(poolPingResult(answerable))
      return
    }
    const listKind = LIST_KIND_BY_METHOD[method]
    if (listKind !== undefined) {
      void handleList(answerable, raw, listKind).catch((error: unknown) => {
        deps.onError(error)
        send(emptyListFrame(answerable, listKind))
      })
      return
    }
    if (ADDRESSED_METHODS.has(method)) {
      handleAddressed(answerable, raw, method)
      return
    }
    // PE3: the pool declares tools and prompts, and nothing else. Resources
    // are a second wave — a URI has no place for a server prefix.
    send(poolMethodNotFoundError(answerable, method))
    record({ event: 'dropped', reason: 'unsupported-method', method })
  }

  function dispatchNotification(method: string, raw: string): void {
    if (method === INITIALIZED_NOTIFICATION) {
      // The plane answered the handshake itself, so this closes a handshake
      // no upstream took part in. Swallowed, not forwarded.
      return
    }
    if (method === CANCELLED_NOTIFICATION) {
      const requestId = cancelledRequestIdOf(raw)
      const server = requestId === null ? undefined : deps.correlator.serverOf(requestId)
      const child = server === undefined ? undefined : deps.children.childOf(server)
      // Nobody holds that id: the request already settled, or never existed.
      // Swallow it — broadcasting a cancel to every upstream would cancel
      // work the agent never asked to stop.
      void child?.sink
        .write(clientMessage(Buffer.from(raw, 'utf8')))
        .catch((error: unknown) => deps.onError(error))
      return
    }
    record({ event: 'dropped', reason: 'unsupported-method', method })
  }

  function handleAgentFrame(bytes: Buffer): void {
    if (isClosed) return
    try {
      const message: ClassifiedMessage = classify(bytes.toString('utf8'))
      if (message.kind === 'request') {
        dispatchRequest(message.id, message.method, message.raw)
        return
      }
      if (message.kind === 'notification') {
        dispatchNotification(message.method, message.raw)
        return
      }
      // A response from the AGENT answers a request the pool never sent (it
      // declares no client capabilities to anyone), and `invalid` is garbage.
      record({ event: 'dropped', reason: 'unreadable' })
    } catch (error: unknown) {
      // Fail closed: the frame is already fully handled (dropped).
      deps.onError(error)
    }
  }

  /**
   * Answers every call the agent had in flight at `server` and forgets them.
   *
   * Must run on EVERY departure, not only a withdrawn grant. When it ran only
   * for the latter, an in-flight call at a child that died was never answered
   * at all — and worse, its correlator entry (keyed by server NAME) outlived
   * the child, so the next child opened for that name could settle it with
   * anything: a fabricated result reaching the agent as genuine. ADR-0015's
   * 2026-09-22 amendment records it in full.
   *
   * Idempotent by construction: `dropServer` on a server with nothing in
   * flight returns no orphans, so several paths may call it.
   */
  function releaseServer(server: string): void {
    for (const orphan of deps.correlator.dropServer(server)) {
      send(poolMemberGoneError(orphan, server))
    }
  }

  async function onMembershipChanged(granted: readonly string[]): Promise<void> {
    if (isClosed) return
    const gone = deps.children.servers().filter((server) => !granted.includes(server))
    // Detached in parallel: these are independent servers, and the agent's
    // `list_changed` waits on the slowest of them either way.
    await Promise.all(
      gone.map(async (server) => {
        // Judged BEFORE the release, which forgets every entry: after it, a
        // departure with calls in flight would look clean, and a held session
        // could be attached again with a reply still on its way (RS5).
        const dirty = deps.correlator.hasPending(server)
        // Before the route goes, so nothing arrives for an already-orphaned
        // id. `detach` releases again via the children's event: a no-op then.
        releaseServer(server)
        await deps.children.detach(server, POOL_DEPARTURE_UNGRANTED, { dirty })
      }),
    )
    // ...and only THEN is the agent told to read the list again. The other
    // order would let it re-read the catalog while the departing server was
    // still in the table and see it one last time.
    send(notificationFrame(TOOLS_LIST_CHANGED_NOTIFICATION))
    send(notificationFrame(PROMPTS_LIST_CHANGED_NOTIFICATION))
    record({ event: 'members-changed', members: [...granted] })
  }

  async function close(): Promise<void> {
    if (isClosed) return
    isClosed = true
    deps.watch.stop()
    // The front has already refused every waiting request, but the correlator
    // still holds them: exactly what says which children leave DIRTY (RS5).
    const dirtyOf = (server: string): boolean => deps.correlator.hasPending(server)
    for (const server of deps.children.servers()) {
      if (dirtyOf(server)) record({ event: 'detach', serverName: server, reason: POOL_DEPARTURE_IN_FLIGHT_AT_CLOSE })
    }
    await deps.children.closeAll({ dirtyOf })
  }

  return Object.freeze({
    handleAgentFrame,
    handleChildFrame,
    releaseServer,
    onMembershipChanged,
    close,
  })
}
