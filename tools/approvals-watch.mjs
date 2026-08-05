#!/usr/bin/env node
// Watches ~/.mcp-journal/approvals/pending and fires a macOS notification for
// every new approval request, with the approve command in the message body.
// Run in a terminal (node tools/approvals-watch.mjs) or as a LaunchAgent.
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PENDING_DIR = join(homedir(), '.mcp-journal', 'approvals', 'pending')
const POLL_INTERVAL_MS = 2000
const NODE_BIN = '/opt/homebrew/bin/node'
const CLI_JS = '<path-to-mcpcut>/dist/cli.js'
/** Dialog auto-dismiss; slightly under the gate's 60s approval wait. */
const DIALOG_GIVE_UP_S = 50

const seen = new Set()
let firstScanDone = false

function log(line) {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`)
}

/** osascript arguments are passed as argv, so no shell quoting can break out. */
function notify(title, subtitle, body) {
  const script =
    'on run argv\n' +
    'display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv) sound name "Glass"\n' +
    'end run'
  execFile('osascript', ['-e', script, title, subtitle, body], (error) => {
    if (error) log(`notify failed: ${error.message}`)
  })
}

/**
 * Actionable dialog: approve/deny right from the popup, no terminal needed.
 * Auto-dismisses after DIALOG_GIVE_UP_S so a missed one never wedges the
 * watcher; the request can still be approved later from the CLI (grant path).
 */
function askAndResolve(id, server, tool, toolClass) {
  const script =
    'on run argv\n' +
    `set res to display dialog (item 1 of argv) with title "MCP Control Plane" buttons {"Пропустить", "Отклонить", "Одобрить"} default button "Одобрить" cancel button "Пропустить" giving up after ${DIALOG_GIVE_UP_S}\n` +
    'if gave up of res then return "skip"\n' +
    'return button returned of res\n' +
    'end run'
  const message = `Агент просит выполнить:\n\n${server} / ${tool}\nкласс: ${toolClass}\nid: ${id}`
  execFile('osascript', ['-e', script, message], (error, stdout) => {
    const choice = error ? 'skip' : stdout.trim() // cancel button rejects with -128
    if (choice !== 'Одобрить' && choice !== 'Отклонить') {
      log(`dialog ${id}: skipped`)
      return
    }
    const action = choice === 'Одобрить' ? 'approve' : 'deny'
    execFile(
      NODE_BIN,
      [CLI_JS, 'approvals', action, id, '--reason', 'resolved from notification dialog'],
      (cliError, cliStdout, cliStderr) => {
        if (cliError) log(`${action} ${id} failed: ${(cliStderr || cliError.message).trim()}`)
        else log(`${action} ${id}: ${cliStdout.trim().split('\n')[0]}`)
      },
    )
  })
}

async function scan() {
  let names = []
  try {
    names = (await readdir(PENDING_DIR)).filter((n) => n.endsWith('.json'))
  } catch {
    return // queue dir not created yet -- nothing pending
  }

  for (const name of names) {
    const id = name.replace('.json', '')
    if (seen.has(id)) continue
    seen.add(id)
    if (!firstScanDone) continue // do not re-announce a backlog on restart

    let entry = null
    try {
      entry = JSON.parse(await readFile(join(PENDING_DIR, name), 'utf8'))
    } catch {
      // file may be mid-write or already resolved; announce by id alone
    }
    const server = entry?.serverName ?? '?'
    const tool = entry?.toolName ?? '?'
    const toolClass = entry?.toolClass ?? '?'
    log(`new approval ${id}: ${server}/${tool} (${toolClass})`)
    notify(
      'MCP: нужна санкция',
      `${server}/${tool} · ${toolClass}`,
      `mcp-journal approvals approve ${id}`,
    )
    askAndResolve(id, server, tool, toolClass)
  }

  // Forget resolved entries so the set does not grow forever.
  const live = new Set(names.map((n) => n.replace('.json', '')))
  for (const id of seen) {
    if (!live.has(id)) seen.delete(id)
  }
}

log(`watching ${PENDING_DIR} (every ${POLL_INTERVAL_MS} ms)`)
await scan()
firstScanDone = true
setInterval(() => {
  scan().catch((error) => log(`scan failed: ${error instanceof Error ? error.message : String(error)}`))
}, POLL_INTERVAL_MS)
