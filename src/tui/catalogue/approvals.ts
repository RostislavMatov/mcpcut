import { APPROVAL_RESOLVE_MIN_ROLE } from '../../admin/authz.js'
import type { FieldSpec } from '../form.js'
import { optionFlag, textField, valueOf } from './fields.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Approvals section (mcpcut phase 4, Task 6): `approvals list|approve|
 * deny` as three declarative actions.
 *
 * Reading the queue is `viewer` — it names no one and changes nothing —
 * while resolving a request is `APPROVAL_RESOLVE_MIN_ROLE`
 * (`src/admin/authz.ts`), the SAME constant `approvals approve|deny` itself
 * checks the token against. Mirrored rather than restated: a threshold typed
 * in twice is a threshold that drifts, and the console's copy exists only to
 * keep an operator from being shown a button their own command would refuse.
 *
 * The threshold here is a UX filter, never the answer. `approvals approve`
 * re-resolves `MCP_ADMIN_TOKEN` through the environment seam the console
 * passes it in (`src/tui/session-env.ts`), and what that token buys is
 * ATTRIBUTION rather than authority (ADR-0004) — the decision is journaled
 * under the admin's name either way.
 *
 * A resolution never expires from this screen: the request the operator is
 * answering may already have timed out at the proxy, in which case the
 * command says so and the agent has to call again (the M2 dogfood UX tail).
 */

/**
 * The request id, as `approvals list` prints it. Not validated against a ULID
 * shape here: the queue is the authority on what one of its own ids looks
 * like, and a second opinion in a form is one that drifts from it.
 */
const idField: FieldSpec = textField('id', 'Id', 'the request id from the list (ULID)', true)

/** Optional free text; it travels into the journaled decision beside the id. */
const reasonField: FieldSpec = textField('reason', 'Reason', 'recorded with the decision')

const listAction: ActionSpec = {
  id: 'list',
  title: 'list',
  minRole: 'viewer',
  command: 'approvals',
  subcommand: 'list',
  fields: [],
  argv: () => ['approvals', 'list'],
}

const approveAction: ActionSpec = {
  id: 'approve',
  title: 'approve',
  minRole: APPROVAL_RESOLVE_MIN_ROLE,
  command: 'approvals',
  subcommand: 'approve',
  fields: [idField, reasonField],
  argv: (values) => [
    'approvals',
    'approve',
    valueOf(values, 'id'),
    ...optionFlag(values, 'reason', '--reason'),
  ],
  hint: 'lets the waiting call through, once, under your name',
}

const denyAction: ActionSpec = {
  id: 'deny',
  title: 'deny',
  minRole: APPROVAL_RESOLVE_MIN_ROLE,
  command: 'approvals',
  subcommand: 'deny',
  fields: [idField, reasonField],
  argv: (values) => [
    'approvals',
    'deny',
    valueOf(values, 'id'),
    ...optionFlag(values, 'reason', '--reason'),
  ],
  hint: 'refuses the waiting call; the agent sees the refusal',
}

/** The human half of the approvals queue: what is waiting, and the answer to it. */
export const APPROVALS_SECTION: SectionSpec = {
  id: 'approvals',
  title: 'Approvals',
  minRole: 'viewer',
  intro: [
    'Pending approval requests from running proxies.',
    'Press r to read the queue again.',
    'Live refresh comes in phase 5.',
  ],
  actions: [listAction, approveAction, denyAction],
  refreshActionId: 'list',
}
