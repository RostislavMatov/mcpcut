import { join, win32 } from 'node:path'
import { PRODUCT_VERSION } from '../brand.js'
import { POLICY_FILE_NAME } from '../policy/constants.js'
import { formatReadableField, replaceControlChars } from '../journal/format.js'
import type { PendingApprovalNotice } from '../proxy/gate-types.js'

const MS_PER_SECOND = 1000

/**
 * The next step, spelled out: every CLI answer on the first-minute path ends
 * in a command the operator can paste as is, with the real id or path filled
 * in (owner's rule 2026-09-29 — nobody should have to open the docs to learn
 * what to type next). Hints go to stderr, so stdout stays the command's data.
 *
 * The Quick start runs mcpcut through `npx`, where a bare `mcpcut …` is
 * "command not found", so a hint names the command the way this process was
 * started: npm sets `npm_command=exec` for `npx` / `npm exec`. Known limits:
 * the variable is inherited, so mcpcut started by another tool that itself
 * runs under npx also gets the npx form (still a command that works);
 * `pnpm dlx` and `bunx` are not recognised and get the bare form; the pin is
 * the running build's version, which npm has for every released build.
 */
export function cliCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env['npm_command'] === 'exec' ? npxCommand() : 'mcpcut'
}

/** The npx form pinned to this build, for a surface that is not itself started by npx (the web UI). */
export function npxCommand(): string {
  return `npx -y mcpcut@${PRODUCT_VERSION}`
}

/** Characters a POSIX shell passes through unquoted and unexpanded. */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/

/**
 * One POSIX shell word, terminal-safe: control characters are replaced first
 * (the value may come from the journal or from argv) but nothing is cut, so
 * the paste stays the same id or path; then anything a shell would split or
 * expand is single-quoted.
 */
export function shellArg(value: string): string {
  const safe = replaceControlChars(value)
  return SHELL_SAFE.test(safe) ? safe : `'${safe.replaceAll("'", `'\\''`)}'`
}

export function recordFirstSessionHint(): string {
  return (
    'To record one, put mcpcut in front of a server in your MCP client, e.g.: ' +
    `claude mcp add <name> -- ${cliCommand()} wrap -- <server command>\n`
  )
}

export function showSessionHint(sessionId: string): string {
  return `Open the latest: ${cliCommand()} show ${shellArg(sessionId)}\n`
}

export function unknownSessionMessage(sessionId: string): string {
  return `No session "${formatReadableField(sessionId)}" in the journal. List them: ${cliCommand()} sessions\n`
}

/** The README's «Stop» policy, on one line: reads pass, everything else waits, no quarantine noise. */
const STARTER_POLICY_JSON =
  '{ "version": 1, "defaultDecision": "require-approval", "classDefaults": { "read": "allow" }, "quarantine": { "enabled": false } }'

/** A server the first minute can wrap as is (the README's Quick start uses it too). */
const EXAMPLE_SERVER_COMMAND = 'npx -y @modelcontextprotocol/server-filesystem .'

/**
 * The empty `approvals list`: what puts a call here, with the real policy
 * file when one sits where mcpcut looks for it, otherwise a command that
 * writes the README's starter policy. No placeholder either way.
 */
export function noPendingApprovalsHint(policyPath?: string): string {
  const why = 'A call waits here when the policy says "require-approval" for it.'
  const cmd = cliCommand()
  if (policyPath !== undefined) {
    return `${why} Put mcpcut in front of your server with that policy: ${cmd} wrap --policy ${shellArg(policyPath)} -- ${EXAMPLE_SERVER_COMMAND}\n`
  }
  return (
    // Not "no policy yet": `approvals list` cannot see a wrap started with `--policy <file>` elsewhere.
    `${why} If you have no policy yet, write a starter one with\n` +
    `  echo '${STARTER_POLICY_JSON}' > policy.json\n` +
    `then put mcpcut in front of your server: ${cmd} wrap --policy "$PWD/policy.json" -- ${EXAMPLE_SERVER_COMMAND}\n`
  )
}

export function resolveApprovalHint(approvalId: string): string {
  const cmd = cliCommand()
  const id = shellArg(approvalId)
  return `Approve: ${cmd} approvals approve ${id}   Deny: ${cmd} approvals deny ${id}\n`
}

/**
 * `wrap`'s stderr line for a held call — the operator's side only. The agent
 * reads its -32002 error instead, which on purpose carries no command: an
 * agent with a shell would run it and approve itself (`synthesize.ts`).
 */
export function heldCallNotice(notice: PendingApprovalNotice): string {
  // M36: no cap by default — the call is held for as long as its agent waits.
  const wait =
    notice.waitMs === undefined
      ? 'the agent waits until you decide or it stops waiting'
      : `the agent waits ${Math.round(notice.waitMs / MS_PER_SECOND)} s`
  return (
    `held for approval: ${formatReadableField(notice.toolName)} on ${formatReadableField(notice.serverName)} ` +
    `(${wait}). ${resolveApprovalHint(notice.approvalId)}`
  )
}

/**
 * The `notifications/progress` text a call held for approval sends its client
 * (decision M36). It travels on the AGENT's channel, and an agent with a shell
 * on the same host could run whatever it is told — before the first admin
 * exists `approvals approve` needs no token — so, like the -32002 error the
 * agent reads at a timeout (`heldCallNotice`), it names neither the approval
 * nor the command that releases it (security review of M36 phase A). The
 * person who approves finds the request in `approvals list` or the console.
 */
export function heldCallProgressText(): string {
  return 'waiting for a person to approve this call'
}

export function listApprovalsHint(): string {
  return `See what is pending: ${cliCommand()} approvals list\n`
}

export function exportReportHint(): string {
  return `Next, sign an audit report: ${cliCommand()} export --report --out ./report\n`
}

export function verifyReportHint(outDir: string): string {
  // A relative path that starts with "-" would read as an option.
  const path = outDir.startsWith('-') ? `./${outDir}` : outDir
  return `Check it offline: ${cliCommand()} verify --report ${shellArg(path)}\n`
}

/**
 * The step that makes the journal tamper-evident: an export alone is only
 * hashes a same-uid process can recompute; a signed head kept elsewhere is
 * what a rewrite cannot match.
 */
export function anchorHeadHint(): string {
  return `Next, anchor the chain head: ${cliCommand()} verify --sign on the journal's host, and keep what it prints somewhere that host cannot rewrite\n`
}

export function keygenHint(): string {
  return `Generate one first with: ${cliCommand()} keygen\n`
}

export function noJournalMessage(journalDir: string): string {
  return (
    `No journal database found under "${formatReadableField(journalDir)}"; nothing has been journaled there yet.\n` +
    `Journal a server first: ${cliCommand()} wrap -- <server command>\n`
  )
}

/*
 * Empty lists and a vault not set up yet (2026-09-29, console pass): the
 * console's Servers, Agents, Groups and Vault panels show exactly this
 * output, so the command that fills each one is named here, for the shell and
 * the console alike. Role-neutral on purpose: a role that may not run it is
 * refused with its own message, and the console's section intro already says
 * who can (`catalogue/next-steps.ts`).
 */

export function noServersHint(): string {
  return `Register one: ${cliCommand()} server add <name> --transport stdio --command <server command>\n`
}

export function noAgentsHint(): string {
  return `Create one: ${cliCommand()} agent create <name>\n`
}

export function noGroupsHint(): string {
  return `Create one: ${cliCommand()} group create <name>\n`
}

export function vaultNotInitializedMessage(): string {
  return `vault is not initialized. Run "${cliCommand()} vault init" first.\n`
}

/**
 * The operator's one line when a server left calls unanswered at the end of a
 * session (decision M36, phase C): which server, how many, and the command
 * that shows the `unanswered` records. The server name comes from the
 * registry or the command line, so it is made readable before it is printed.
 */
export function unansweredCallsNotice(serverName: string, count: number, sessionId: string): string {
  const calls = count === 1 ? '1 call' : `${count} calls`
  const pronoun = count === 1 ? 'it' : 'them'
  return (
    `server "${formatReadableField(serverName)}" did not answer ${calls} before its session closed ` +
    `(journaled "unanswered"); see ${pronoun}: ${cliCommand()} show ${shellArg(sessionId)} --kind decision\n`
  )
}

/** The line `wrap` writes when the session ends: the id and the command that reads it back. */
export function sessionJournaledNotice(sessionId: string): string {
  const id = shellArg(sessionId)
  return `session ${id} journaled: ${cliCommand()} show ${id}\n`
}

/**
 * `policy: none found, journaling only` plus the next step: the path a policy
 * is picked up from without a flag (the first default location searched) and
 * the flag that names one. `wrap` only: the operator launches it.
 */
export function noPolicyNotice(defaultPath: string | undefined): string {
  const where = defaultPath === undefined ? '' : `save it as ${shellArg(defaultPath)} (picked up automatically) or `
  return `policy: none found, journaling only\n  To add a policy: ${where}pass --policy <path>\n`
}

/**
 * The same notice for `connect`: the agent launches it, so `--policy` is
 * refused there and the project folder is not read — the one place an
 * operator's policy is picked up from is the plane's own directory.
 */
export function connectNoPolicyNotice(journalDir: string): string {
  const path = shellArg(join(journalDir, POLICY_FILE_NAME))
  return `policy: none found, journaling only (agent grants still apply)\n  To add a policy: save it as ${path} (picked up automatically)\n`
}

/** `wrap`'s usage example: a real server command on the directory the operator is in. */
export function wrapExampleLine(cwd: string): string {
  return `Example: ${cliCommand()} wrap --server fs -- npx -y @modelcontextprotocol/server-filesystem ${shellArg(cwd)}\n`
}

/** What `wrap` tried to start and how the platform refused it (a `SpawnServerError`'s fields). */
export interface SpawnFailure {
  readonly command: string
  readonly args: readonly string[]
  readonly code: string | undefined
}

/** npm installs its commands on Windows as `.cmd` scripts, which only a shell can start. */
const WINDOWS_SCRIPT_EXTENSIONS: readonly string[] = ['', '.cmd', '.bat']

/** Characters cmd or PowerShell would split or act on outside double quotes. */
const WINDOWS_SPECIAL = /[\s&|<>^$;`(),']/
/** `%VAR%` expands even inside cmd's quotes, and an inner quote has no escape cmd and CRT agree on. */
const WINDOWS_UNPASTEABLE = /[%"]/

/**
 * One word for cmd or PowerShell, control characters replaced: double-quoted
 * when it holds a special character, with a trailing backslash doubled so it
 * cannot escape the closing quote. Words `WINDOWS_UNPASTEABLE` matches are
 * never quoted here — the caller prints the rule instead of a line.
 */
function windowsArg(value: string): string {
  const safe = replaceControlChars(value)
  return WINDOWS_SPECIAL.test(safe) ? `"${safe.replace(/\\+$/, (tail) => tail + tail)}"` : safe
}

/**
 * The next step after `wrap` failed to start the server. On Windows `npx`
 * and every other npm command is a `.cmd` script that cannot be started
 * without a shell, so the line spells out the same server behind `cmd /c` —
 * the form Claude Code's own docs give for Windows (smoke of 0.2.4 on
 * Windows: the README command died on `spawn npx ENOENT`). Elsewhere a
 * missing command is named with where to fix it. Empty when there is nothing
 * to add.
 */
export function spawnFailureHint(failure: SpawnFailure, platform: NodeJS.Platform = process.platform): string {
  const isNotFound = failure.code === 'ENOENT'
  const isWindowsScript =
    platform === 'win32' &&
    (isNotFound || failure.code === 'EINVAL') &&
    WINDOWS_SCRIPT_EXTENSIONS.includes(win32.extname(failure.command).toLowerCase())
  if (isWindowsScript) {
    const words = [failure.command, ...failure.args]
    const rule = '  On Windows, start npm commands such as npx through cmd: put "cmd /c" right after "--"'
    if (words.some((word) => WINDOWS_UNPASTEABLE.test(word))) return `${rule}\n`
    return `${rule}, as in: -- cmd /c ${words.map(windowsArg).join(' ')}\n`
  }
  if (isNotFound) {
    return `  ${shellArg(failure.command)} was not found: install it, or give its full path after "--"\n`
  }
  return ''
}
