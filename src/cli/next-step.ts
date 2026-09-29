import { PRODUCT_VERSION } from '../brand.js'
import { formatReadableField, replaceControlChars } from '../journal/format.js'

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
  return env['npm_command'] === 'exec' ? `npx -y mcpcut@${PRODUCT_VERSION}` : 'mcpcut'
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

export function noPendingApprovalsHint(): string {
  return (
    'A call waits here when the policy says "require-approval" for it: ' +
    `${cliCommand()} wrap --policy <policy.json> -- <server command>\n`
  )
}

export function resolveApprovalHint(approvalId: string): string {
  const cmd = cliCommand()
  const id = shellArg(approvalId)
  return `Approve: ${cmd} approvals approve ${id}   Deny: ${cmd} approvals deny ${id}\n`
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

export function keygenHint(): string {
  return `Generate one first with: ${cliCommand()} keygen\n`
}

export function noJournalMessage(journalDir: string): string {
  return (
    `No journal database found under "${formatReadableField(journalDir)}"; nothing has been journaled there yet.\n` +
    `Journal a server first: ${cliCommand()} wrap -- <server command>\n`
  )
}
