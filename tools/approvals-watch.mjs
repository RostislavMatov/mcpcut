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
