import { POLICY_HASH_PREVIEW_CHARS } from '../policy/constants.js'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { roleSatisfies, type Role } from '../admin/authz.js'
import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import { JOURNAL_DIR } from '../config.js'
import { formatReadableField } from '../journal/format.js'
import type { PolicyEditActor } from '../journal/policy-edit-record.js'
import type { JournalSinkOptions } from '../journal/sink.js'
import { journalPolicyEdit } from '../policy/edit/journal-edit.js'
import {
  defaultPolicyFileDeps,
  readPolicyFileForEdit,
  writePolicyFile,
  type PolicyFileDeps,
  type PolicyFileReadResult,
} from '../policy/edit/policy-file.js'
import { applyToolRuleToDocument } from '../policy/edit/set-tool-rule.js'
import {
  defaultPolicyWriteTargetDeps,
  resolvePolicyWriteTarget,
  type PolicyWriteTargetDeps,
} from '../policy/edit/write-target.js'
import { effectiveToolRule, type EffectiveToolRule } from '../policy/effective.js'
import { INVENTORY_FILE_NAME } from '../policy/inventory.js'
import { POLICY_OUTCOME_VALUES, type Policy, type PolicyOutcome } from '../policy/schema.js'
import { adminFromEnv } from './admin-token.js'
import type { PolicyCliIo } from './policy-cmd.js'
import { toolFactsForEffectiveRule } from './policy-set-facts.js'

/**
 * `policy set <server> <tool> allow|require-approval|deny|clear` — the CLI
 * parity of the Servers-card rule buttons (policy-tool-rules-ui plan §7,
 * owner decision O6; ADR-0009 §6). Same pure edit, same CAS file write, same
 * `policy-edit` journal record (`via: 'cli'`) as the UI, under the same
 * `owner` role — so the UI's role table cannot be stepped around from a
 * shell (ADR-0004 lesson).
 *
 * Writes ONLY `<journalDir>/policy.json`, the source `connect` loads; a
 * nested `<journalDir>/.mcp-journal/policy.json` that `connect` would load
 * FIRST makes the command refuse rather than write into nowhere (finding
 * 5a). A missing file is refused too (O4): enforcement is a mode the
 * operator switches on deliberately, never as a side effect of one rule.
 */

/** Minimum role to change a rule — mirrors the `POST /servers/:name/tools/:tool/rule` row in `src/ui/authz.ts`. */
export const POLICY_SET_MIN_ROLE: Role = 'owner'

/** The fourth positional that removes the exact rule instead of setting one. */
const CLEAR_WORD = 'clear'

/** Accepted fourth positionals, in the order the usage line lists them. */
const RULE_WORDS: readonly string[] = ['allow', 'require-approval', 'deny', CLEAR_WORD]

/** Leading hex digits of a policy hash shown in the human line; the journal carries the full digest. */

const SET_USAGE = `Usage:
  policy set <server> <tool> allow|require-approval|deny|clear [--json]
                                Write (or clear) one exact per-tool rule in
                                <journal dir>/policy.json (personal admin token via
                                ${ADMIN_TOKEN_ENV_VAR}, role ${POLICY_SET_MIN_ROLE})
`

const MISSING_TOKEN_MESSAGE =
  `Refusing to edit the policy: no admin token. Set ${ADMIN_TOKEN_ENV_VAR} to your personal admin token ` +
  `(role "${POLICY_SET_MIN_ROLE}") so the edit records which admin made it.\n` +
  `Get one with: mcp-journal admin add <name> --role ${POLICY_SET_MIN_ROLE}   (existing admin: mcp-journal admin rotate <name>)\n`

const UNKNOWN_TOKEN_MESSAGE =
  `Refusing to edit the policy: ${ADMIN_TOKEN_ENV_VAR} does not match any active admin — it may have been ` +
  `rotated, or the admin removed.\n` +
  `Check "mcp-journal admin list", then: mcp-journal admin rotate <name>\n`

function insufficientRoleMessage(adminName: string): string {
  return (
    `Refusing to edit the policy: this admin token's role may not change rules ` +
    `(role "${POLICY_SET_MIN_ROLE}" is required, the same rule the admin UI applies to ` +
    `POST /servers/:name/tools/:tool/rule).\n` +
    `An owner can change it with: mcp-journal admin role ${formatReadableField(adminName)} ${POLICY_SET_MIN_ROLE}\n`
  )
}

function storeUnreadableMessage(detail: string): string {
  return (
    `Refusing to edit the policy: the admin store could not be read, so the edit could not be ` +
    `attributed to a human.\n${formatReadableField(detail)}\n` +
    `Check the file named above, then: mcp-journal admin list\n`
  )
}

/** Hot reload is wave 2 of the same plan (`src/policy/reload.ts`), so the reminder is unconditional. */
const RELOAD_REMINDER = 'running proxies pick this up without restart (ADR-0009)\n'

/** Test seams; production uses the defaults. */
export interface PolicySetDeps {
  readonly policyFile?: PolicyFileDeps
  readonly writeTarget?: PolicyWriteTargetDeps
  /** Journal sink fault-injection seams (retry delay, commit). */
  readonly sink?: Pick<JournalSinkOptions, 'retryDelayMs' | 'commitBatchImpl'>
}

export interface PolicySetOptions {
  /** Journal directory: holds `policy.json`, the admin store and `journal.db`. Defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Environment to read `MCP_ADMIN_TOKEN` from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Clock for the journal record. Defaults to `Date.now`. */
  readonly clock?: () => number
  readonly deps?: PolicySetDeps
}

const DEFAULT_IO: PolicyCliIo = { stdout: process.stdout, stderr: process.stderr }

interface SetArgs {
  readonly serverName: string
  readonly toolName: string
  readonly rule: PolicyOutcome | null
  readonly json: boolean
}

/** Parses the three positionals and `--json`; `undefined` (usage already printed) on any shape error. */
function parseSetArgs(args: string[], io: PolicyCliIo): SetArgs | undefined {
  let positionals: string[]
  let json: boolean
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { json: { type: 'boolean', default: false } },
      allowPositionals: true,
      strict: true,
    })
    positionals = parsed.positionals
    json = parsed.values.json === true
  } catch {
    io.stderr.write(SET_USAGE)
    return undefined
  }
  const [serverName, toolName, ruleWord] = positionals
  if (positionals.length !== 3 || serverName === undefined || toolName === undefined || ruleWord === undefined) {
    io.stderr.write(SET_USAGE)
    return undefined
  }
  const rule = ruleOf(ruleWord)
  if (rule === undefined) {
    io.stderr.write(`policy set: rule must be one of ${RULE_WORDS.join(', ')}\n${SET_USAGE}`)
    return undefined
  }
  return { serverName, toolName, rule, json }
}

/** `null` for `clear`, the outcome for a schema outcome word, `undefined` for anything else. */
function ruleOf(word: string): PolicyOutcome | null | undefined {
  if (word === CLEAR_WORD) return null
  return POLICY_OUTCOME_VALUES.find((candidate) => candidate === word)
}

/** The owner behind `MCP_ADMIN_TOKEN`, or `undefined` with the refusal already printed. */
async function resolveOwner(io: PolicyCliIo, opts: PolicySetOptions): Promise<PolicyEditActor | undefined> {
  const resolved = await adminFromEnv(opts)
  if (resolved.kind === 'missing') {
    io.stderr.write(MISSING_TOKEN_MESSAGE)
    return undefined
  }
  if (resolved.kind === 'unknown') {
    io.stderr.write(UNKNOWN_TOKEN_MESSAGE)
    return undefined
  }
  if (resolved.kind === 'unreadable') {
    io.stderr.write(storeUnreadableMessage(resolved.detail))
    return undefined
  }
  if (!roleSatisfies(resolved.role, POLICY_SET_MIN_ROLE)) {
    io.stderr.write(insufficientRoleMessage(resolved.name))
    return undefined
  }
  return { adminName: resolved.name, role: resolved.role, via: 'cli' }
}

/** The flat file, or `undefined` with the shadowing explained (finding 5a). */
async function resolveTargetPath(journalDir: string, io: PolicyCliIo, opts: PolicySetOptions): Promise<string | undefined> {
  const target = await resolvePolicyWriteTarget(journalDir, opts.deps?.writeTarget ?? defaultPolicyWriteTargetDeps)
  if (target.status === 'shadowed') {
    io.stderr.write(
      `Refusing to edit ${target.path}: connect loads ${target.shadowedBy} first, so a rule written here ` +
        `would never reach an agent. Edit that file by hand or remove it, then re-run.\n`,
    )
    return undefined
  }
  return target.path
}

function absentFileMessage(path: string): string {
  return (
    `no policy file at ${path} -- enforcement is off; create it by hand first ` +
    `(see README, "policy.json example")\n`
  )
}

/** Reads the file for editing; `undefined` with the reason printed when there is nothing valid to edit. */
async function readEditable(
  path: string,
  io: PolicyCliIo,
  fileDeps: PolicyFileDeps,
): Promise<Extract<PolicyFileReadResult, { status: 'loaded' }> | undefined> {
  const read = await readPolicyFileForEdit(path, fileDeps)
  if (read.status === 'absent') {
    io.stderr.write(absentFileMessage(path))
    return undefined
  }
  if (read.status === 'error') {
    io.stderr.write(read.errors.map((line) => `${path}: ${line}\n`).join(''))
    return undefined
  }
  return read
}

interface WrittenEdit {
  readonly hashBefore: string
  readonly hashAfter: string
  readonly policy: Policy
}

/** Applies the edit and writes it under CAS; `undefined` with the failure printed otherwise. */
async function applyAndWrite(
  path: string,
  loaded: Extract<PolicyFileReadResult, { status: 'loaded' }>,
  args: SetArgs,
  io: PolicyCliIo,
  fileDeps: PolicyFileDeps,
): Promise<WrittenEdit | undefined> {
  const edited = applyToolRuleToDocument(loaded.document, args.serverName, args.toolName, args.rule)
  if (!edited.ok) {
    io.stderr.write(`policy set: ${formatReadableField(edited.message)}\n`)
    return undefined
  }
  const written = await writePolicyFile(path, edited.document, { expectedHash: loaded.hash }, fileDeps)
  if (written.status === 'conflict') {
    const found = written.currentHash === null ? 'no file' : previewOf(written.currentHash)
    io.stderr.write(
      `policy changed on disk while editing (expected ${previewOf(loaded.hash)}, found ${found}) -- re-run the command\n`,
    )
    return undefined
  }
  if (written.status === 'error') {
    io.stderr.write(written.errors.map((line) => `${path}: ${line}\n`).join(''))
    return undefined
  }
  // `hashBefore` is never null here: an absent file was refused before the edit.
  return { hashBefore: written.hashBefore ?? loaded.hash, hashAfter: written.hashAfter, policy: edited.policy }
}

/** Writes the `policy-edit` record and flushes; a drop is said out loud, never fatal (the file IS written). */
async function journalEdit(
  actor: PolicyEditActor,
  args: SetArgs,
  edit: WrittenEdit,
  sourcePath: string,
  journalDir: string,
  io: PolicyCliIo,
  opts: PolicySetOptions,
): Promise<void> {
  const outcome = await journalPolicyEdit({
    edit: {
      actor,
      serverName: args.serverName,
      toolName: args.toolName,
      rule: args.rule,
      policyHashBefore: edit.hashBefore,
      policyHashAfter: edit.hashAfter,
      sourcePath,
    },
    dir: journalDir,
    diagnostics: (line) => io.stderr.write(line),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.deps?.sink !== undefined ? { sinkOptions: opts.deps.sink } : {}),
  })
  if (!outcome.written) {
    io.stderr.write(
      `[journal] the policy edit was applied, but its journal record was dropped (see the sink diagnostics above)\n`,
    )
  }
}

function previewOf(hash: string): string {
  return hash.slice(0, POLICY_HASH_PREVIEW_CHARS)
}

function ruleWordOf(rule: PolicyOutcome | null): string {
  return rule ?? 'cleared'
}

/** The audit line (O5): who, what, and the fingerprints — on stderr, next to every other store change made from a shell. */
function auditLineOf(actor: PolicyEditActor, args: SetArgs, edit: WrittenEdit): string {
  const target = `${formatReadableField(args.serverName)}/${formatReadableField(args.toolName)}`
  return (
    `[audit] policy set by ${formatReadableField(actor.adminName)} (${actor.role}): ` +
    `${target} = ${ruleWordOf(args.rule)}, ${previewOf(edit.hashBefore)} -> ${previewOf(edit.hashAfter)}\n`
  )
}

function reportHuman(args: SetArgs, edit: WrittenEdit, effective: EffectiveToolRule, io: PolicyCliIo): void {
  const target = `${formatReadableField(args.serverName)}/${formatReadableField(args.toolName)}`
  io.stdout.write(
    `policy ${previewOf(edit.hashBefore)} -> ${previewOf(edit.hashAfter)}: ${target} = ${ruleWordOf(args.rule)}; ` +
      `effective now: ${effective.outcome} (${effective.source})\n`,
  )
  io.stdout.write(RELOAD_REMINDER)
}

function reportJson(args: SetArgs, edit: WrittenEdit, effective: EffectiveToolRule, sourcePath: string, io: PolicyCliIo): void {
  io.stdout.write(
    `${JSON.stringify({
      server: args.serverName,
      tool: args.toolName,
      rule: args.rule,
      hashBefore: edit.hashBefore,
      hashAfter: edit.hashAfter,
      effective: { outcome: effective.outcome, source: effective.source, rulePath: effective.rulePath },
      sourcePath,
    })}\n`,
  )
}

/**
 * `policy set <server> <tool> allow|require-approval|deny|clear [--json]`.
 * Exit 0 when the file was written (even if the journal dropped the record —
 * that is reported, not hidden); 1 on every refusal, with the reason printed.
 */
export async function runPolicySet(
  args: string[],
  io: PolicyCliIo = DEFAULT_IO,
  opts: PolicySetOptions = {},
): Promise<number> {
  const parsed = parseSetArgs(args, io)
  if (parsed === undefined) return 1
  const actor = await resolveOwner(io, opts)
  if (actor === undefined) return 1

  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const path = await resolveTargetPath(journalDir, io, opts)
  if (path === undefined) return 1
  const fileDeps = opts.deps?.policyFile ?? defaultPolicyFileDeps
  const loaded = await readEditable(path, io, fileDeps)
  if (loaded === undefined) return 1
  const edit = await applyAndWrite(path, loaded, parsed, io, fileDeps)
  if (edit === undefined) return 1

  io.stderr.write(auditLineOf(actor, parsed, edit))
  await journalEdit(actor, parsed, edit, path, journalDir, io, opts)

  const tool = await toolFactsForEffectiveRule(join(journalDir, INVENTORY_FILE_NAME), parsed.serverName, parsed.toolName, io)
  const effective = effectiveToolRule({ policy: edit.policy, serverName: parsed.serverName, tool })
  if (parsed.json) {
    reportJson(parsed, edit, effective, path, io)
  } else {
    reportHuman(parsed, edit, effective, io)
  }
  return 0
}
