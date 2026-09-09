import { z } from 'zod'
import { hostAuthority } from '../services/authority.js'
import type { ServiceState } from '../services/manager-types.js'
import { sanitizeLine } from './ansi.js'
import { EXTERNAL_GLYPH } from './constants-live.js'

/**
 * The services part of the console header (plan phase 2, task 8).
 *
 * The console is a client of the service manager, not a second copy of it: it
 * learns what is running by running `services status --json` through the same
 * dispatcher every other action goes through, and reads the document back
 * here. That makes the text below untrusted input in the ordinary sense — it
 * arrives as bytes from a command — so it is validated with a schema rather
 * than cast, and a document that does not fit yields `undefined` instead of a
 * throw: a header that cannot say what the services are is a header that says
 * so, never a console that fell over on its own status line.
 *
 * The schema is deliberately NOT strict. `ServiceStatus` carries `logPath`,
 * `pid`, `startedAt` and a `detail` the header has no room for, and a field
 * added to it later must not blank the line; every field the header DOES read
 * is validated, which is the half that matters.
 */

/** What the header shows for one service — the four fields it has room for. */
export interface ServiceSummary {
  readonly service: string
  readonly state: string
  readonly host: string
  readonly port: number
}

/**
 * The state glyphs — four glyphs: running ●, starting ◐, external ◉ —
 * answering, not ours; everything else ○.
 *
 * `external` earned its own glyph in phase 5 (Q16): under compose or systemd
 * every service is `external`, and drawing that as `○` told a whole class of
 * install that everything was down and to go press `start` — on services that
 * were serving and that mcpcut may not touch. `stopped` and `stale` still
 * share `○`: both mean "nothing is answering and you may start it", and the
 * `status` table is where the difference between them is drawn.
 */
const RUNNING_GLYPH = '●'
const STARTING_GLYPH = '◐'
const OTHER_GLYPH = '○'

/**
 * One glyph PER STATE of the manager's own union, for the same reason
 * `DOWN_BY_STATE` below is a record and not a list of words: a state added to
 * `ServiceState` fails to compile here until somebody has said what it looks
 * like on the header, rather than falling through to `○` and telling a whole
 * class of install that a service nobody can start is down.
 */
const GLYPH_BY_STATE: Readonly<Record<ServiceState, string>> = {
  running: RUNNING_GLYPH,
  starting: STARTING_GLYPH,
  external: EXTERNAL_GLYPH,
  stopped: OTHER_GLYPH,
  stale: OTHER_GLYPH,
}

/**
 * The same table keyed by BYTES, the way `DOWN_STATES` below is: `state`
 * reaches us through `z.string()`, so the lookup takes any word and a state of
 * no union member simply is not in the map.
 */
const GLYPHS: ReadonlyMap<string, string> = new Map(Object.entries(GLYPH_BY_STATE))

/**
 * What "a service is down" means to the console, answered ONCE PER STATE of
 * the manager's own union rather than as a list of words. A state added to
 * `ServiceState` then fails to compile here until somebody says whether an
 * operator could act on it — the alternative, a `string[]`, would have every
 * new state default silently to "not down" (F12).
 */
const DOWN_BY_STATE: Readonly<Record<ServiceState, boolean>> = {
  stopped: true,
  stale: true,
  running: false,
  starting: false,
  // Answering, and its supervisor — not mcpcut — owns it.
  external: false,
}

/**
 * The same answer as a lookup over BYTES: `state` reaches us through
 * `z.string()`, so the set is keyed by string and a word that is in no state
 * of the union simply is not in it.
 */
const DOWN_STATES: ReadonlySet<string> = new Set(
  Object.entries(DOWN_BY_STATE)
    .filter(([, isDown]) => isDown)
    .map(([state]) => state),
)

/** Separator between two services, matching the header's own field separator. */
const SERVICE_SEPARATOR = ' · '

/** What the header says when the status could not be read, or named nothing. */
export const NO_SERVICES_TEXT = 'services: —'

/** Only the fields the header reads; anything else in the document is dropped. */
const summarySchema = z.object({
  service: z.string(),
  state: z.string(),
  host: z.string(),
  port: z.number(),
})

const summaryListSchema = z.array(summarySchema)

/** Parses `services status --json`; `undefined` for anything it cannot read. Never throws. */
export function parseServicesJson(text: string): readonly ServiceSummary[] | undefined {
  const parsed = summaryListSchema.safeParse(parseJson(text))
  return parsed.success ? parsed.data : undefined
}

/**
 * `ui ● 127.0.0.1:8091 · serve ○ 127.0.0.1:8090`, or the unknown-services text.
 *
 * Sanitised here rather than left to `padRight`: the schema validates the
 * SHAPE of the document, and `z.string()` says nothing about a charset, so
 * every name, state and host in it is still bytes a command printed. The
 * sign-in banner measures this line to centre its block BEFORE the renderer
 * pads it, so an escape sequence in a host would misplace the whole block even
 * where it could not reach the terminal — and this is the one screen string
 * that was not being sanitised at its source.
 */
export function servicesHeaderPart(statuses: readonly ServiceSummary[] | undefined): string {
  if (statuses === undefined || statuses.length === 0) return NO_SERVICES_TEXT
  return sanitizeLine(statuses.map(summaryPart).join(SERVICE_SEPARATOR))
}

function summaryPart(summary: ServiceSummary): string {
  return `${summary.service} ${glyphOf(summary.state)} ${hostAuthority(summary.host, summary.port)}`
}

/** A word this module does not recognise gets `○` rather than nothing at all. */
function glyphOf(state: string): string {
  return GLYPHS.get(state) ?? OTHER_GLYPH
}

/**
 * Is this service one an operator could bring up? `external` is deliberately
 * NOT down: it answers, and its supervisor — not mcpcut — owns it. A state
 * this module does not recognise is not down either: the word arrives as bytes
 * from a command, and guessing would raise a banner about nothing.
 */
export function isServiceDown(state: string): boolean {
  return DOWN_STATES.has(state)
}

/** Any service down at all — the one question the sign-in banner asks. */
export function hasDownService(statuses: readonly ServiceSummary[] | undefined): boolean {
  return statuses?.some((summary) => isServiceDown(summary.state)) === true
}

/** `JSON.parse` as a total function: bad text is a value the schema rejects. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
