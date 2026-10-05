import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { effectiveGrantsOf } from '../agents/effective.js'
import { AgentNotFoundError } from '../agents/store.js'
import { createAgentsStore } from '../agents/store.js'
import { JOURNAL_DIR } from '../config.js'
import { rootsOutsideDataDir } from '../files/data-overlap.js'
import { TRASH_DIR_NAME, FILES_SERVER_NAME } from '../files/constants.js'
import { FilesDbError } from '../files/db/errors.js'
import { RuleRefusedError } from '../files/grant-admin.js'
import { RootsLimitError, createRootsStore } from '../files/roots-store.js'
import { IndexRulesLimitError } from '../files/search/index-rules-store.js'
import { GroupNotFoundError, createGroupsStore } from '../groups/store.js'
import { formatReadableField } from '../journal/format.js'
import { BuiltinServerRefusedError } from '../tenant/errors.js'
import { StoreCorruptError, StoreLockError, StoreWriteRejectedError } from '../policy/store.js'
import type { AccessWriteOptions } from './access-cmd-write.js'
import type { AgentCliIo } from './agent-cmd.js'
import {
  FILES_USAGE,
  formatRuleLines,
  formatRulesOrigin,
  grantNextStep,
} from './files-cmd-format.js'
import { runAudit } from './files-cmd-audit.js'
import { runDb } from './files-cmd-db.js'
import type { FilesDbCliSeams } from './files-db-seams.js'
import { runSetup } from './files-cmd-setup.js'
import { runIndex } from './files-cmd-index.js'
import { isGroupForm, runGroupGrant, runGroupRevoke, runGroupShow } from './files-cmd-group.js'
import { runTrash } from './files-cmd-trash.js'
import { findAgent, runGrant, runRevoke, runRootAdd, runRootRemove } from './files-cmd-write.js'
import { cliCommand, shellArg } from './next-step.js'

/**
 * `mcpcut files root|grant|revoke|show|audit|trash|setup|db` — the admin side of the file module
 * (ADR-0020 §2). Same shape as `agent-cmd.ts`: injectable io and options,
 * exit code returned, expected errors become one stderr line. Changes need an
 * owner token and leave an audit line plus an `access-edit` record
 * (`files-cmd-write.ts`); `root list` and `show` are free.
 */

export interface FilesCliOptions extends AccessWriteOptions {
  /** @internal test seams for `files setup` and `files db …`. */
  readonly db?: FilesDbCliSeams
}

const DEFAULT_IO: AgentCliIo = { stdout: process.stdout, stderr: process.stderr }

const EXPECTED_ERRORS = [
  AgentNotFoundError,
  GroupNotFoundError,
  BuiltinServerRefusedError,
  RootsLimitError,
  IndexRulesLimitError,
  RuleRefusedError,
  StoreCorruptError,
  StoreLockError,
  StoreWriteRejectedError,
  FilesDbError,
] as const

export async function runFilesCommand(
  args: string[],
  io: AgentCliIo = DEFAULT_IO,
  opts: FilesCliOptions = {},
): Promise<number> {
  const [subcommand, ...rest] = args
  try {
    switch (subcommand) {
      case 'root':
        return await runRoot(rest, io, opts)
      case 'grant':
        return await (isGroupForm(rest) ? runGroupGrant : runGrant)(rest, io, opts)
      case 'revoke':
        return await (isGroupForm(rest) ? runGroupRevoke : runRevoke)(rest, io, opts)
      case 'show':
        return await (isGroupForm(rest) ? runGroupShow : runShow)(rest, io, opts)
      case 'audit':
        return await runAudit(rest, io, opts)
      case 'trash':
        return await runTrash(rest, io, opts)
      case 'setup':
        return await runSetup(rest, io, opts)
      case 'db':
        return await runDb(rest, io, opts)
      case 'index':
        return await runIndex(rest, io, opts)
      default:
        io.stderr.write(FILES_USAGE)
        return 1
    }
  } catch (error: unknown) {
    if (EXPECTED_ERRORS.some((kind) => error instanceof kind)) {
      io.stderr.write(`${formatReadableField((error as Error).message)}\n`)
      return 1
    }
    throw error
  }
}

async function runRoot(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const [action, ...rest] = args
  if (action === 'add') return runRootAdd(rest, io, opts)
  if (action === 'remove') return runRootRemove(rest, io, opts)
  if (action === 'list') return runRootList(io, opts)
  io.stderr.write(FILES_USAGE)
  return 1
}

/** Whether the root's trash is a real folder right now. */
async function trashState(root: string): Promise<'ok' | 'missing'> {
  const info = await lstat(path.join(root, TRASH_DIR_NAME)).catch(() => null)
  return info !== null && info.isDirectory() && !info.isSymbolicLink() ? 'ok' : 'missing'
}

async function runRootList(io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const journalDir = opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}
  const roots = await createRootsStore(journalDir).list()
  const cli = cliCommand(opts.env)
  if (roots.length === 0) {
    io.stdout.write('(no roots)\n')
    io.stderr.write(`Add one: ${cli} files root add <folder>\n`)
    return 0
  }
  const states = await Promise.all(roots.map((root) => trashState(root.path)))
  const safe = new Set(await rootsOutsideDataDir(roots.map((root) => root.path), opts.journalDir ?? JOURNAL_DIR))
  const unsafe = roots.find((root) => !safe.has(root.path))
  roots.forEach((root, index) => {
    const note = safe.has(root.path) ? '' : `  unsafe: holds mcpcut data — remove it: ${cli} files root remove ${shellArg(root.path)}`
    io.stdout.write(`${formatReadableField(root.path)}  trash ${states[index]}  added ${formatReadableField(root.addedAt)}${note}\n`)
  })
  if (unsafe !== undefined) {
    io.stderr.write(`Agents cannot reach ${formatReadableField(unsafe.path)} while it overlaps mcpcut data: ${cli} files root remove ${shellArg(unsafe.path)}\n`)
    return 0
  }
  const missing = roots.find((_root, index) => states[index] === 'missing')
  if (missing !== undefined) {
    io.stderr.write(`A trash is missing. Recreate it: ${cli} files root add ${shellArg(missing.path)}\n`)
  }
  const agents = await createAgentsStore(journalDir).listAgents()
  io.stderr.write(grantNextStep(opts.env ?? process.env, agents, roots[0]?.path ?? ''))
  return 0
}

async function runShow(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const [name] = args
  if (name === undefined || args.length !== 1) {
    io.stderr.write(FILES_USAGE)
    return 1
  }
  const agent = await findAgent(io, opts, name)
  if (agent === undefined) return 1
  const journalDir = opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}
  const groups = await createGroupsStore(journalDir).listGroups()
  const effective = effectiveGrantsOf(agent, groups)
  const rules = effective.grants[FILES_SERVER_NAME]?.paths ?? []
  const label = formatReadableField(name)
  if (rules.length === 0) {
    io.stdout.write(`${label} has no file access\n`)
    io.stderr.write(`Give a folder: ${cliCommand(opts.env)} files grant ${shellArg(name)} <folder> --ops read\n`)
    return 0
  }
  io.stdout.write(`${label}'s folder rules${formatRulesOrigin(effective.sources[FILES_SERVER_NAME])}:\n`)
  io.stdout.write(`${formatRuleLines(rules).join('\n')}\n`)
  io.stderr.write(`Change one: ${cliCommand(opts.env)} files grant ${shellArg(name)} ${shellArg(rules[0]?.path ?? '<folder>')} --ops read\n`)
  return 0
}
