#!/usr/bin/env node
/**
 * Smoke run of the PUBLISHED package on whatever OS runs it (CI matrix:
 * Windows and Linux). It walks the README Quick start — See, Stop, Prove —
 * as a stranger would, and records every step instead of stopping at the
 * first failure, so one run tells the whole story of a platform.
 *
 * Usage: MCPCUT_VERSION=0.4.0 node tools/smoke/published-smoke.mjs
 *        MCPCUT_TARBALL=/abs/mcpcut-x.y.z.tgz node tools/smoke/published-smoke.mjs  (a build not yet on npm)
 * Writes smoke-results-<source>.json to the working directory and a Markdown
 * table to $GITHUB_STEP_SUMMARY when it is set. Exit code 1 if any step failed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = process.env.MCPCUT_VERSION ?? '0.4.0'
const TARBALL = process.env.MCPCUT_TARBALL
/** What npm installs and what `npx` runs: the registry version, or a packed build of this checkout. */
const INSTALL_SPEC = TARBALL ?? `mcpcut@${VERSION}`
const NPX_ARGS = TARBALL ? ['-y', `--package=${TARBALL}`, 'mcpcut'] : ['-y', `mcpcut@${VERSION}`]
const SOURCE = TARBALL ? 'local build' : `npm ${VERSION}`
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
// Every mcpcut this script starts journals, queues approvals and reads keys
// here — never in the data dir of whoever runs it (a developer's own install
// took four smoke sessions and a pending approval before this line, 2026-10-01).
process.env.MCPCUT_DATA_DIR = join(work, 'mcpcut-data')
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
const install = shell(`npm i --no-audit --no-fund --prefix "${join(work, 'pkg')}" "${INSTALL_SPEC}" ${SERVER_PKG}`, 300_000)
record('npm install mcpcut + server-filesystem', install.code === 0, install.out.trim().split('\n').slice(-3).join('\n'))
const CLI = join(work, 'pkg', 'node_modules', 'mcpcut', 'dist', 'cli.js')
const SERVER_JS = join(work, 'pkg', 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js')

function mcpcut(args, timeout = CLI_TIMEOUT_MS) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: work, timeout })
  return { code: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** `node <cli.js> wrap --server fs [extra] -- <inner>`: what the npx shim ends up running. */
function wrapLauncher(innerCommand, innerArgs, extraWrapArgs = []) {
  return [process.execPath, [CLI, 'wrap', '--server', 'fs', ...extraWrapArgs, '--', innerCommand, ...innerArgs]]
}

/** A minimal MCP client over newline-delimited JSON-RPC on the launched process's stdio. */
function openClient([command, args]) {
  const child = spawn(command, args, {
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

/** See: one wrapped session that lists and reads, started by the given launcher. */
async function seeStep(label, launcher) {
  const client = openClient(launcher)
  try {
    const names = await handshake(client)
    const readTool = names.includes('read_text_file') ? 'read_text_file' : 'read_file'
    const listed = await client.request('tools/call', { name: 'list_directory', arguments: { path: project } })
    const read = await client.request('tools/call', { name: readTool, arguments: { path: join(project, 'hello.txt') } })
    const ok = JSON.stringify(listed).includes('hello.txt') && JSON.stringify(read).includes('hello from the smoke run')
    const closed = await client.close()
    record(`See: ${label}`, ok, `${names.length} tools; list+read ${ok ? 'answered' : 'WRONG'}; wrap exited ${closed.code} in ${closed.ms} ms`)
  } catch (error) {
    await client.close()
    record(`See: ${label}`, false, `${error.message}\nstderr: ${client.stderr().trim().slice(-800)}`)
  }
}

/** Stop: a write waits until approved from "another terminal" (a separate process). */
async function stopStep() {
  const policyPath = join(work, 'policy.json')
  writeFileSync(policyPath, JSON.stringify({ version: 1, defaultDecision: 'require-approval', classDefaults: { read: 'allow' }, quarantine: { enabled: false } }))
  const client = openClient(wrapLauncher('node', [SERVER_JS, project], ['--policy', policyPath]))
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

/** On Windows the README's bare `npx` cannot be spawned; the failure must name the `cmd /c` fix. */
async function windowsHintStep() {
  const client = openClient(wrapLauncher('npx', ['-y', SERVER_PKG, project]))
  const code = await Promise.race([client.exited, new Promise((r) => setTimeout(() => r('still running'), 30_000))])
  if (code === 'still running') await client.close()
  const hint = client.stderr().split('\n').find((line) => line.includes('cmd /c')) ?? ''
  record('Windows: bare npx after -- names the cmd /c form', hint.includes(`-- cmd /c npx -y ${SERVER_PKG}`), `wrap exited ${code}; ${hint.trim() || client.stderr().trim().slice(-400)}`)
}

/**
 * adopt (a build of this checkout only — the registry versions predate it):
 * a Claude Code config in a throwaway home is shown, rewritten, the written
 * line is started the way the client starts it and must answer, and undo puts
 * the file back as it was.
 */
async function adoptStep() {
  const home = join(work, 'adopt-home')
  mkdirSync(home)
  const config = join(home, '.claude.json')
  const original = { numStartups: 1, mcpServers: { fs: { command: 'npx', args: ['-y', SERVER_PKG, project] } } }
  writeFileSync(config, `${JSON.stringify(original, null, 2)}\n`)
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') }
  const adopt = (args) => {
    const r = spawnSync(process.execPath, [CLI, 'adopt', ...args], { encoding: 'utf8', cwd: project, env, timeout: CLI_TIMEOUT_MS })
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }
  const shown = adopt([])
  record('adopt: shows the change, writes nothing', shown.code === 0 && /fs\s+wrap/.test(shown.out) && readFileSync(config, 'utf8').includes('"npx"'), shown.out.trim().split('\n').slice(0, 6).join('\n'))
  const applied = adopt(['--apply'])
  const entry = JSON.parse(readFileSync(config, 'utf8')).mcpServers.fs
  const line = `${entry.command} ${entry.args.join(' ')}`
  record('adopt --apply: the entry starts mcpcut wrap', applied.code === 0 && entry.args.includes('wrap'), `${line}\n${applied.out.trim().split('\n').slice(-2).join('\n')}`)
  await seeStep('the line adopt wrote, started as the client starts it', [entry.command, entry.args])
  const undone = adopt(['--undo'])
  const back = JSON.stringify(JSON.parse(readFileSync(config, 'utf8'))) === JSON.stringify(original)
  record('adopt --undo: the file is as it was', undone.code === 0 && back, undone.out.trim())
}

/** The version npm actually installed: the registry pin, or whatever the packed checkout says. */
function installedVersion() {
  try {
    return JSON.parse(readFileSync(join(work, 'pkg', 'node_modules', 'mcpcut', 'package.json'), 'utf8')).version
  } catch {
    return VERSION
  }
}

const npxVersion = shell(`npx ${NPX_ARGS.join(' ')} --version`)
record(`npx ${NPX_ARGS.join(' ')} --version`, npxVersion.code === 0 && npxVersion.out.includes(installedVersion()), npxVersion.out.trim())

if (IS_WINDOWS) {
  await windowsHintStep()
  // The README's Windows line, as Claude Code spawns it: cmd /c in front of both npx.
  await seeStep('cmd /c npx mcpcut wrap -- cmd /c npx server (the README Windows line)',
    ['cmd', ['/c', 'npx', ...NPX_ARGS, 'wrap', '--server', 'fs', '--', 'cmd', '/c', 'npx', '-y', SERVER_PKG, project]])
} else {
  await seeStep('npx mcpcut wrap -- npx server (the README line)', ['npx', [...NPX_ARGS, 'wrap', '--server', 'fs', '--', 'npx', '-y', SERVER_PKG, project]])
}
await seeStep('wrap -- node <server>/dist/index.js', wrapLauncher('node', [SERVER_JS, project]))
journalSteps()
await stopStep()
proveSteps()
if (TARBALL) await adoptStep()

const failed = results.filter((r) => !r.ok)
writeFileSync(join(process.cwd(), `smoke-results-${TARBALL ? 'local' : 'npm'}.json`), JSON.stringify({ platform: process.platform, node: process.version, source: SOURCE, results }, null, 2))
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.step} | ${r.detail.split('\n')[0].replaceAll('|', '\\|')} |`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### mcpcut (${SOURCE}) on ${process.platform} (${process.version})\n\n| | Step | Detail |\n|---|---|---|\n${rows.join('\n')}\n\n`)
}
console.log(`\n${results.length - failed.length}/${results.length} steps passed on ${process.platform} (${SOURCE})`)
process.exit(failed.length === 0 ? 0 : 1)
