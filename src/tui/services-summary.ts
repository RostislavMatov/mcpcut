import { z } from 'zod'
import { hostAuthority } from '../services/authority.js'

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
 * The state glyphs. Three, not five: `running` and `starting` are the two
 * states an operator acts on differently, and `stopped`, `stale` and
 * `external` all mean "not answering for us" on a line this narrow — the
 * `status` table is where the distinction between them is drawn.
 */
const RUNNING_GLYPH = '●'
const STARTING_GLYPH = '◐'
const OTHER_GLYPH = '○'

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

/** `ui ● 127.0.0.1:8091 · serve ○ 127.0.0.1:8090`, or the unknown-services text. */
export function servicesHeaderPart(statuses: readonly ServiceSummary[] | undefined): string {
  if (statuses === undefined || statuses.length === 0) return NO_SERVICES_TEXT
  return statuses.map(summaryPart).join(SERVICE_SEPARATOR)
}

function summaryPart(summary: ServiceSummary): string {
  return `${summary.service} ${glyphOf(summary.state)} ${hostAuthority(summary.host, summary.port)}`
}

function glyphOf(state: string): string {
  if (state === 'running') return RUNNING_GLYPH
  if (state === 'starting') return STARTING_GLYPH
  return OTHER_GLYPH
}

/** `JSON.parse` as a total function: bad text is a value the schema rejects. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
