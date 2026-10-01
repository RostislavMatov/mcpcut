#!/usr/bin/env node
/**
 * Smoke run of the PUBLISHED package on whatever OS runs it (CI matrix:
 * Windows and Linux). It walks the README Quick start — See, Stop, Prove —
 * as a stranger would, and records every step instead of stopping at the
 * first failure, so one run tells the whole story of a platform.
 *
 * Usage: MCPCUT_VERSION=0.2.4 node tools/smoke/published-smoke.mjs
 * Writes smoke-results.json next to the working directory and a Markdown
 * table to $GITHUB_STEP_SUMMARY when it is set. Exit code 1 if any step failed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = process.env.MCPCUT_VERSION ?? '0.2.4'
const SERVER_PKG = '@modelcontextprotocol/server-filesystem'
const IS_WINDOWS = process.platform === 'win32'
/** The first start downloads the server through npx; give it room. */
const INIT_TIMEOUT_MS = 120_000
const CALL_TIMEOUT_MS = 30_000
/** The README's agent wait is 60 s; approve well inside it. */
const APPROVAL_POLL_MS = 1_000
const APPROVAL_POLL_TRIES = 40
const CLI_TIMEOUT_MS = 120_000
/** Built at runtime so no secret-shaped literal sits in the source. */
const FAKE_SECRET = ['ghp', '_', 'Smoke'.repeat(7), 'X'].join('')

const results = []
const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mcpcut-smoke-')))
const project = join(work, 'project')
mkdirSync(project)
writeFileSync(join(project, 'hello.txt'), `hello from the smoke run\ntoken=${FAKE_SECRET}\n`)

function record(step, ok, detail) {
  results.push({ step, ok, detail: String(detail).slice(0, 1500) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}\n      ${String(detail).split('\n').join('\n      ')}`)
}

function shell(command, timeout = CLI_TIMEOUT_MS) {
  const r = spawnSync(command, { shell: true, encoding: 'utf8', cwd: work, timeout })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error }
}

// Install once into a private prefix; `node <cli.js>` is what the npx shim runs.
const install = shell(`npm i --no-audit --no-fund --prefix "${join(work, 'pkg')}" mcpcut@${VERSION} ${SERVER_PKG}`, 300_000)
record('npm install mcpcut + server-filesystem', install.code === 0, install.out.trim().split('\n').slice(-3).join('\n'))
const CLI = join(work, 'pkg', 'node_modules', 'mcpcut', 'dist', 'cli.js')
const SERVER_JS = join(work, 'pkg', 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js')

function mcpcut(args, timeout = CLI_TIMEOUT_MS) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: work, timeout })
  return { code: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** A minimal MCP client over newline-delimited JSON-RPC on the wrapped server's stdio. */
function openClient(innerCommand, innerArgs, extraWrapArgs = []) {
  const child = spawn(process.execPath, [CLI, 'wrap', '--server', 'fs', ...extraWrapArgs, '--', innerCommand, ...innerArgs], {
    cwd: work,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let buffer = ''
  let stderr = ''
  let nextId = 1
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg)
          pending.delete(msg.id)
        }
      } catch { /* non-JSON noise on stdout is itself worth seeing in stderr dumps */ }
    }
  })
  const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)))
  child.once('error', (error) => { stderr += `spawn error: ${error.message}` })

  function request(method, params, timeout = CALL_TIMEOUT_MS) {
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no answer in ${timeout} ms`)) }, timeout)
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    })
  }
  function notify(method) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }
  async function close() {
    child.stdin.end()
    const started = Date.now()
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15_000))])
    if (code === 'timeout') child.kill()
    return { code, ms: Date.now() - started }
  }
  return { request, notify, close, stderr: () => stderr, exited }
}

async function handshake(client) {
  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcpcut-smoke', version: '1' },
  }, INIT_TIMEOUT_MS)
  if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`)
  client.notify('notifications/initialized')
  const list = await client.request('tools/list', {})
  const names = (list.result?.tools ?? []).map((t) => t.name)
  if (names.length === 0) throw new Error(`tools/list empty: ${JSON.stringify(list).slice(0, 300)}`)
  return names
}

/** See: one wrapped session that lists and reads, with the given inner command. */
async function seeStep(label, innerCommand, innerArgs) {
  const client = openClient(innerCommand, innerArgs)
  try {
    const names = await handshake(client)
    const readTool = names.includes('read_text_file') ? 'read_text_file' : 'read_file'
    const listed = await client.request('tools/call', { name: 'list_directory', arguments: { path: project } })
    const read = await client.request('tools/call', { name: readTool, arguments: { path: join(project, 'hello.txt') } })
    const ok = JSON.stringify(listed).includes('hello.txt') && JSON.stringify(read).includes('hello from the smoke run')
    const closed = await client.close()
    record(`See: wrap -- ${label}`, ok, `${names.length} tools; list+read ${ok ? 'answered' : 'WRONG'}; wrap exited ${closed.code} in ${closed.ms} ms`)
  } catch (error) {
    await client.close()
    record(`See: wrap -- ${label}`, false, `${error.message}\nstderr: ${client.stderr().trim().slice(-800)}`)
  }
}

/** Stop: a write waits until approved from "another terminal" (a separate process). */
async function stopStep() {
  const policyPath = join(work, 'policy.json')
  writeFileSync(policyPath, JSON.stringify({ version: 1, defaultDecision: 'require-approval', classDefaults: { read: 'allow' }, quarantine: { enabled: false } }))
  const client = openClient('node', [SERVER_JS, project], ['--policy', policyPath])
  try {
    await handshake(client)
    const target = join(project, 'approved.txt')
    const call = client.request('tools/call', { name: 'write_file', arguments: { path: target, content: 'written after approval' } }, 90_000)
    let id
    let lastList = ''
    for (let i = 0; i < APPROVAL_POLL_TRIES && !id; i++) {
      await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS))
      const listed = mcpcut(['approvals', 'list', '--json'])
      lastList = listed.out
      try { id = JSON.parse(listed.stdout.trim()).approvals?.[0]?.approvalId } catch { /* not yet */ }
    }
    if (!id) throw new Error(`no pending approval appeared within 40 s; last list: ${lastList.trim().slice(0, 400)}`)
    const approved = mcpcut(['approvals', 'approve', id])
    const answer = await call
    const ok = approved.code === 0 && !answer.error && existsSync(target)
    record('Stop: held write approved from a second process', ok, `approve exit ${approved.code}: ${approved.out.trim().split('\n')[0]}\nanswer: ${JSON.stringify(answer).slice(0, 200)}`)
  } catch (error) {
    record('Stop: held write approved from a second process', false, `${error.message}\nstderr: ${client.stderr().trim().slice(-800)}`)
  } finally {
    await client.close()
  }
}

function journalSteps() {
  const sessions = mcpcut(['sessions'])
  const ids = [...new Set(sessions.out.match(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g) ?? [])]
  record('sessions', sessions.code === 0 && ids.length > 0, sessions.out.trim().split('\n').slice(0, 6).join('\n'))
  const shows = ids.map((id) => mcpcut(['show', id]))
  const leaked = shows.some((s) => s.out.includes(FAKE_SECRET))
  const withCalls = shows.filter((s) => s.code === 0 && s.out.includes('list_directory')).length
  record('show <id>: calls journaled, secret redacted', withCalls > 0 && !leaked, `${ids.length} session(s), ${withCalls} with the calls; secret ${leaked ? 'LEAKED' : 'redacted'}`)
}

function proveSteps() {
  for (const [step, args] of [
    ['keygen', ['keygen']],
    ['export --report', ['export', '--report', '--out', join(work, 'report')]],
    ['verify --report', ['verify', '--report', join(work, 'report')]],
    ['verify --sign', ['verify', '--sign']],
  ]) {
    const r = mcpcut(args)
    record(`Prove: ${step}`, r.code === 0, `exit ${r.code}: ${r.out.trim().split('\n').slice(0, 3).join('\n')}`)
  }
}

const npxVersion = shell(`npx -y mcpcut@${VERSION} --version`)
record('npx -y mcpcut --version', npxVersion.code === 0 && npxVersion.out.includes(VERSION), npxVersion.out.trim())

await seeStep('npx -y server-filesystem (the README form)', 'npx', ['-y', SERVER_PKG, project])
if (IS_WINDOWS) await seeStep('cmd /c npx -y server-filesystem', 'cmd', ['/c', 'npx', '-y', SERVER_PKG, project])
await seeStep('node <server>/dist/index.js', 'node', [SERVER_JS, project])
journalSteps()
await stopStep()
proveSteps()

const failed = results.filter((r) => !r.ok)
writeFileSync(join(process.cwd(), 'smoke-results.json'), JSON.stringify({ platform: process.platform, node: process.version, version: VERSION, results }, null, 2))
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.step} | ${r.detail.split('\n')[0].replaceAll('|', '\\|')} |`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### mcpcut@${VERSION} on ${process.platform} (${process.version})\n\n| | Step | Detail |\n|---|---|---|\n${rows.join('\n')}\n\n`)
}
console.log(`\n${results.length - failed.length}/${results.length} steps passed on ${process.platform}`)
process.exit(failed.length === 0 ? 0 : 1)
