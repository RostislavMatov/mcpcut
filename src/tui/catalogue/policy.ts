import { POLICY_SET_MIN_ROLE, RULE_WORDS } from '../../cli/policy-set-cmd.js'
import { TOOL_RULE_NAME_PATTERN } from '../../policy/constants.js'
import { ENTRY_POINTS } from '../../policy/source.js'
import type { FieldSpec } from '../form.js'
import {
  choiceFlag,
  flagField,
  optionalChoice,
  patternField,
  positional,
  switchFlag,
  textField,
  valueOf,
} from './fields.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Policy section (mcpcut phase 4, Task 4): `policy show`, `policy show
 * --server`, `policy validate` and `policy set` as four declarative actions.
 *
 * Whose threshold each `minRole` mirrors:
 * - `show`, `show --server`, `validate` — `viewer`, the `GET /servers` row of
 *   `ROUTE_TABLE` (`src/ui/authz.ts`; read, never imported from here). There
 *   is NO `/policy` route: the effective policy is what the servers page
 *   shows, tool by tool, and reading it is what a viewer role exists for.
 * - `set` — `POLICY_SET_MIN_ROLE`, imported from the command itself rather
 *   than restated: that constant is already the mirror of
 *   `POST /servers/:name/tools/:tool/rule` (owner), and a second copy here
 *   would be a second answer to who may change a rule (ADR-0009).
 *
 * `show --server` gets its own action rather than optional fields on `show`,
 * because one action = one command line the pane can print truthfully; the
 * plan records that as D3.
 *
 * The rule words and the entry-point names are imported, not typed out: a
 * fourth positional the CLI does not know would be refused after the operator
 * had already filled the form, and `ENTRY_POINTS` is the same list the
 * `policy show` usage line prints (ADR-0005).
 */

const serverField: FieldSpec = textField('server', 'Server', undefined, true)

/** Tool rules accept an exact name or a single trailing glob — the store's own shape. */
const toolField: FieldSpec = patternField('tool', 'Tool', TOOL_RULE_NAME_PATTERN)

/** Which entry point's source-resolution order to answer for; "any" = this shell's. */
const entryPointField: FieldSpec = optionalChoice('entry-point', 'Entry point', ENTRY_POINTS)

const jsonField: FieldSpec = flagField('json', 'JSON')

const pathField: FieldSpec = textField('path', 'Path', 'empty = the resolved policy file')

const ruleField: FieldSpec = {
  name: 'rule',
  label: 'Rule',
  kind: 'choice',
  options: RULE_WORDS,
}

const showAction: ActionSpec = {
  id: 'show',
  title: 'show',
  minRole: 'viewer',
  command: 'policy',
  subcommand: 'show',
  fields: [],
  argv: () => ['policy', 'show'],
}

const showServerAction: ActionSpec = {
  id: 'show-server',
  title: 'show --server',
  minRole: 'viewer',
  command: 'policy',
  subcommand: 'show',
  fields: [serverField, entryPointField, jsonField],
  argv: (values) => [
    'policy',
    'show',
    '--server',
    valueOf(values, 'server'),
    ...choiceFlag(values, 'entry-point', '--entry-point'),
    ...switchFlag(values, 'json', '--json'),
  ],
}

const validateAction: ActionSpec = {
  id: 'validate',
  title: 'validate',
  minRole: 'viewer',
  command: 'policy',
  subcommand: 'validate',
  fields: [pathField],
  argv: (values) => ['policy', 'validate', ...positional(values, 'path')],
}

const setAction: ActionSpec = {
  id: 'set',
  title: 'set',
  minRole: POLICY_SET_MIN_ROLE,
  command: 'policy',
  subcommand: 'set',
  fields: [serverField, toolField, ruleField],
  argv: (values) => [
    'policy',
    'set',
    valueOf(values, 'server'),
    valueOf(values, 'tool'),
    valueOf(values, 'rule'),
  ],
  hint: 'writes one rule to policy.json; proxies reload it',
}

/** Which tools run, which wait for a human, and which are refused outright. */
export const POLICY_SECTION: SectionSpec = {
  id: 'policy',
  title: 'Policy',
  minRole: 'viewer',
  intro: [
    'The effective policy: which tools run, which wait',
    'for approval, which are denied.',
  ],
  actions: [showAction, showServerAction, validateAction, setAction],
  refreshActionId: 'show',
}
