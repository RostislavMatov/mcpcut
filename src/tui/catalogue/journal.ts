import { SESSION_ID_PATTERN } from '../../config.js'
import { JOURNAL_DIRECTIONS, JOURNAL_KINDS } from '../../journal/reader.js'
import { EXPORT_OUT_HINT } from '../constants.js'
import type { FieldSpec } from '../form.js'
import {
  choiceFlag,
  flagField,
  optionFlag,
  optionalChoice,
  optionalSessionField,
  patternField,
  switchFlag,
  textField,
  valueOf,
} from './fields.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Journal section (mcpcut phase 4, Task 6): `sessions`, `show` and
 * `export` as three declarative actions.
 *
 * All three are `viewer`: reading the journal names nobody and changes
 * nothing, and the commands themselves ask for no token. The section is where
 * the console's ONE output-to-file seam lives — `export` streams JSONL with
 * no upper bound while the pane keeps `OUTPUT_MAX_LINES` (2 000) lines, so
 * its records go to the path in the `out` field via `stdoutToField` and the
 * pane shows a one-line receipt instead (`savedToLine`).
 *
 * The path is deliberately NOT in argv: `mcpcut export` has no `--out`
 * of its own (that flag belongs to `export --report`, which is the Audit
 * section's action), and a path appended anyway would be read as a stray
 * positional. The runtime opens the file itself with `wx`, which is why the
 * hint says "refused if it exists".
 *
 * The vocabularies of `--direction` and `--kind` are imported from
 * `src/journal/reader.ts` — the same arrays the CLI validates against — so a
 * kind added to the journal reaches this screen without being retyped.
 * `client→server` carries a real arrow; it is not a control character and
 * travels to the command line as written.
 */

/** The session id, validated by the pattern the reader itself enforces. */
const sessionIdField: FieldSpec = patternField('session', 'Session', SESSION_ID_PATTERN)

const sessionsAction: ActionSpec = {
  id: 'sessions',
  title: 'sessions',
  minRole: 'viewer',
  command: 'sessions',
  fields: [],
  argv: () => ['sessions'],
}

const showAction: ActionSpec = {
  id: 'show',
  title: 'show',
  minRole: 'viewer',
  command: 'show',
  fields: [
    sessionIdField,
    textField('method', 'Method', 'exact JSON-RPC method, e.g. tools/call'),
    optionalChoice('direction', 'Direction', JOURNAL_DIRECTIONS),
    optionalChoice('kind', 'Kind', JOURNAL_KINDS),
    flagField('json', 'JSON', 'one JSON array instead of the table'),
  ],
  argv: (values) => [
    'show',
    valueOf(values, 'session'),
    ...optionFlag(values, 'method', '--method'),
    ...choiceFlag(values, 'direction', '--direction'),
    ...choiceFlag(values, 'kind', '--kind'),
    ...switchFlag(values, 'json', '--json'),
  ],
}

const exportAction: ActionSpec = {
  id: 'export',
  title: 'export',
  minRole: 'viewer',
  command: 'export',
  fields: [textField('out', 'Out', EXPORT_OUT_HINT, true), optionalSessionField],
  argv: (values) => ['export', ...optionFlag(values, 'session', '--session')],
  stdoutToField: 'out',
  hint: 'JSONL, one record per line, written to the file above',
}

/** What was journaled: the sessions, one session's records, and a copy of them. */
export const JOURNAL_SECTION: SectionSpec = {
  id: 'journal',
  title: 'Journal',
  minRole: 'viewer',
  intro: [
    'Journaled sessions and their records; export writes',
    'JSONL to a file (the pane keeps only 2000 lines).',
  ],
  actions: [sessionsAction, showAction, exportAction],
  refreshActionId: 'sessions',
}
