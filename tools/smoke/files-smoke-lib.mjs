/**
 * Helpers of tools/smoke/files-smoke.mjs: step recording, the installed CLI,
 * and a minimal MCP client over the stdio of `mcpcut connect`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CALL_TIMEOUT_MS = 30_000
const INIT_TIMEOUT_MS = 60_000
const CLOSE_TIMEOUT_MS = 15_000
export const CLI_TIMEOUT_MS = 120_000

export const results = []

/** Every step is recorded, never thrown: one run tells the whole story of a platform. */
export function record(step, ok, detail) {
  const text = String(detail)
  results.push({ step, ok, detail: text.slice(0, 1500) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}\n      ${text.split('\n').join('\n      ')}`)
}

/** Run a step body; an exception becomes a FAIL instead of ending the run. */
export async function step(name, body) {
  try {
    const outcome = await body()
    record(name, outcome.ok, outcome.detail)
  } catch (error) {
    record(name, false, `threw: ${error instanceof Error ? error.message : error}`)
  }
}

export function shell(command, cwd, timeout = CLI_TIMEOUT_MS) {
  const r = spawnSync(command, { shell: true, encoding: 'utf8', cwd, timeout })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** The installed CLI, run as the npx shim runs it. `env` carries the owner token when a command needs it. */
export function makeCli(cliPath, cwd, baseEnv) {
  return (args, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd, env: { ...baseEnv, ...extraEnv }, timeout: CLI_TIMEOUT_MS })
    return { code: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }
}

/** A minimal MCP client over newline-delimited JSON-RPC on the launched process's stdio. */
export function openClient(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
      } catch { /* noise on stdout shows up in the stderr dump of a failed step */ }
    }
  })
  const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)))
  child.once('error', (error) => { stderr += `spawn error: ${error.message}` })

  function request(method, params, timeout = CALL_TIMEOUT_MS) {
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no answer in ${timeout} ms\nstderr: ${stderr.trim().slice(-600)}`)) }, timeout)
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    })
  }
  async function handshake() {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcpcut-files-smoke', version: '1' } }, INIT_TIMEOUT_MS)
    if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const list = await request('tools/list', {})
    return (list.result?.tools ?? []).map((t) => t.name)
  }
  /** One tools/call, flattened: `error` is the JSON-RPC refusal (message + data.rule), `text` the tool's answer. */
  async function call(name, args) {
    const answer = await request('tools/call', { name, arguments: args })
    const text = (answer.result?.content ?? []).map((c) => c.text ?? '').join('\n')
    return {
      error: answer.error ?? null,
      isError: answer.result?.isError === true,
      rule: answer.error?.data?.rule ?? '',
      text: text || (answer.error?.message ?? ''),
      raw: JSON.stringify(answer),
    }
  }
  async function close() {
    child.stdin.end()
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), CLOSE_TIMEOUT_MS))])
    if (code === 'timeout') child.kill()
    return code
  }
  return { handshake, call, close, stderr: () => stderr }
}

export function writeResults(name, meta) {
  writeFileSync(join(process.cwd(), `smoke-results-${name}.json`), JSON.stringify({ ...meta, results }, null, 2))
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.step} | ${r.detail.split('\n')[0].replaceAll('|', '\\|')} |`)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### mcpcut file module (${meta.source}) on ${meta.platform} (${meta.node})\n\n| | Step | Detail |\n|---|---|---|\n${rows.join('\n')}\n\n`)
  }
}
