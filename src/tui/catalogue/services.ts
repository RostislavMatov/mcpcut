import { SIGKILL_ESCALATION_MS } from '../../config.js'
import {
  LOG_TAIL_DEFAULT_LINES,
  SERVICE_NAMES,
  START_READY_TIMEOUT_MS,
} from '../../services/constants.js'
import { MS_PER_SECOND } from '../constants-live.js'
import type { FieldSpec, FormValues } from '../form.js'
import { choiceField, optionFlag, textField, valueOf } from './fields.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Services section (mcpcut phase 5, Task 3): `status`, `start`, `stop`
 * and `logs` over this install's own two daemons, and `setup` — the one
 * action of the whole catalogue that is not dispatched from here at all.
 *
 * The four service verbs are HOST operations: they read a pid file, send a
 * signal, probe a port and tail a file. None of them opens the journal or the
 * admin store, which is why none of them has a token gate and none is about
 * to get one — the same shape `keygen` and `backup` have in Audit. `setup`
 * carries `leavesConsole`: a console already running the old catalogue cannot
 * honestly host the wizard that rewrites the install underneath it
 * (ADR-0012 §16), so the console ends and `mcpcut setup` takes the terminal.
 *
 * WHOSE THRESHOLDS THESE ARE (plan P5). No route in `ROUTE_TABLE`
 * (`src/ui/authz.ts`) covers any of these commands — there is no way to start
 * a daemon from a browser — so, exactly as in `audit.ts`, these roles mirror
 * nothing. They are a MENU FILTER, not a barrier: whoever has a shell on this
 * host has all five commands, and the console only keeps a screen free of
 * dead ends.
 *
 * - `status` is `viewer`: a table of two ports names nobody.
 * - `logs` sits ABOVE `viewer` on purpose. `run/ui.log` holds whatever the
 *   daemon wrote at boot, and after `setup --yes --no-admin` that includes the
 *   bootstrap token (ADR-0012, "Consequences") — a tail is therefore not a
 *   read a viewer is offered.
 * - `start` and `stop` are `operator`: they move what agents can reach.
 * - `setup` is `owner`: it rewrites the install config.
 *
 * `start` and `stop` also carry `requires: 'own-supervisor'`. Under
 * `supervisor: external` compose or systemd owns the processes, mcpcut only
 * reports on them (Q16), and a button that would signal a pid we do not
 * manage is worse than no button.
 */

/** The choice value that means "not one service — both of them". */
const BOTH = 'both'

/**
 * The order each verb offers, and the order the CLI acts in: `ui` first up,
 * `serve` first down (`START_ORDER`/`STOP_ORDER`, `src/cli/service-cmd-args.ts`).
 * Repeated here rather than imported: `service-cmd-args.ts` is the flag parser,
 * and the catalogue must not drag `parseArgs` and a usage table into its graph
 * to learn two names it already has from `SERVICE_NAMES`.
 */
const START_CHOICES: readonly string[] = [BOTH, ...SERVICE_NAMES]
const STOP_CHOICES: readonly string[] = [BOTH, ...[...SERVICE_NAMES].reverse()]
const LOGS_CHOICES: readonly string[] = SERVICE_NAMES

/** What `--lines` accepts: a positive whole number, the way `logs` parses it. */
const LINES_PATTERN = /^[1-9]\d*$/

/** The refusal the Lines field prints; the grammar it names is the command's. */
const LINES_ERROR = 'a positive whole number'

/** The positional `start`/`stop` take, or nothing at all — which means both. */
function serviceArg(values: FormValues): readonly string[] {
  const service = valueOf(values, 'service')
  return service === BOTH ? [] : [service]
}

/** What a question calls the chosen service, or the pair of them. */
function whatOf(values: FormValues): string {
  return valueOf(values, 'service') === BOTH ? SERVICE_NAMES.join(' and ') : valueOf(values, 'service')
}

/** Tail length; blank leaves `--lines` out and the command uses its own default. */
const linesField: FieldSpec = {
  ...textField('lines', 'Lines', `tail length; default ${LOG_TAIL_DEFAULT_LINES}`),
  validate: (value) => {
    const typed = value.trim()
    return typed === '' || LINES_PATTERN.test(typed) ? undefined : LINES_ERROR
  },
}

const statusAction: ActionSpec = {
  id: 'status',
  title: 'status',
  minRole: 'viewer',
  command: 'status',
  fields: [],
  argv: () => ['status'],
}

const startAction: ActionSpec = {
  id: 'start',
  title: 'start',
  minRole: 'operator',
  command: 'start',
  requires: 'own-supervisor',
  fields: [choiceField('service', 'Service', START_CHOICES, `${BOTH} = ui, then serve`)],
  argv: (values) => ['start', ...serviceArg(values)],
  // No question (plan P7): bringing a daemon up takes nothing away, and a
  // reflex trained to dismiss this one would dismiss `stop`'s too.
  hint: `detached daemons; waits up to ${START_READY_TIMEOUT_MS / MS_PER_SECOND} s per service`,
}

const stopAction: ActionSpec = {
  id: 'stop',
  title: 'stop',
  minRole: 'operator',
  command: 'stop',
  requires: 'own-supervisor',
  fields: [choiceField('service', 'Service', STOP_CHOICES, `${BOTH} = serve, then ui`)],
  argv: (values) => ['stop', ...serviceArg(values)],
  confirm: (values) =>
    `Stop ${whatOf(values)}? Agents lose the front and the web console ` +
    'goes down; this console keeps running.',
  hint: `SIGTERM, SIGKILL after ${SIGKILL_ESCALATION_MS / MS_PER_SECOND} s; pid file cleared`,
}

const logsAction: ActionSpec = {
  id: 'logs',
  title: 'logs',
  minRole: 'operator',
  command: 'logs',
  fields: [choiceField('service', 'Service', LOGS_CHOICES), linesField],
  argv: (values) => ['logs', valueOf(values, 'service'), ...optionFlag(values, 'lines', '--lines')],
  hint: 'daemon log tail; may quote upstream MCP servers',
}

const setupAction: ActionSpec = {
  id: 'setup',
  title: 'setup',
  minRole: 'owner',
  command: 'setup',
  leavesConsole: true,
  fields: [],
  argv: () => ['setup'],
  confirm: () => 'Leave the console for the setup screen? It reopens the console when done.',
  hint: 'edits the install in the wizard; the console reopens',
}

/** The daemons this console is a client of: what they are doing, and who moves them. */
export const SERVICES_SECTION: SectionSpec = {
  id: 'services',
  title: 'Services',
  minRole: 'viewer',
  intro: [
    'ui and serve as the manager sees them: pid alive AND',
    'the probe answering (ADR-0012). They outlive this',
    'console; q never stops them. Under supervisor:',
    'external (compose/systemd) start and stop are hidden.',
  ],
  actions: [statusAction, startAction, stopAction, logsAction, setupAction],
  refreshActionId: 'status',
}
