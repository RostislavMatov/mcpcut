#!/usr/bin/env node
/**
 * Smoke run of the FILE MODULE of a packed build on whatever OS runs it (CI
 * matrix: Windows, Linux, macOS). An owner declares a folder and grants an
 * agent; the agent connects over stdio and works; every refusal is checked by
 * the error the tool returns, not by absence of content.
 *
 * Usage: MCPCUT_TARBALL=/abs/mcpcut-x.y.z.tgz node tools/smoke/files-smoke.mjs
 * Writes smoke-results-files.json to the working directory and a Markdown
 * table to $GITHUB_STEP_SUMMARY when it is set. Exit code 1 if any step failed.
 * Everything lives in a fresh temp dir with MCPCUT_DATA_DIR inside it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCli, openClient, record, results, shell, step, writeResults } from './files-smoke-lib.mjs'

const TARBALL = process.env.MCPCUT_TARBALL
if (!TARBALL) {
  console.error('MCPCUT_TARBALL (an absolute path to a packed mcpcut-*.tgz) is required: the file module is not on npm yet.')
  process.exit(2)
}
const PLATFORM = process.platform
const AGENT = 'smoke-agent'
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/
const SENTINEL = 'PRIVATE-SENTINEL-4711'
const OUTSIDE_SENTINEL = 'OUTSIDE-SENTINEL-4711'
const CLI_PACKAGE_DIR = ['node_modules', 'mcpcut', 'dist', 'cli.js']

const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mcpcut-files-smoke-')))
const dataDir = join(work, 'mcpcut-data')
// MCPCUT_FILES_SMOKE_DIR (an existing empty folder, e.g. a mounted share) moves the
// project, the outside file and the carve-outs there; the data dir stays local.
const areaRoot = process.env.MCPCUT_FILES_SMOKE_DIR
const area = areaRoot ? realpathSync.native(mkdtempSync(join(areaRoot, 'mcpcut-files-smoke-'))) : work
const project = join(area, 'project')
const privateDir = join(project, 'private')
const outsideFile = join(area, 'outside.txt')
mkdirSync(privateDir, { recursive: true })
writeFileSync(join(privateDir, 'x.txt'), SENTINEL)
writeFileSync(outsideFile, OUTSIDE_SENTINEL)
// Never the data dir of whoever runs this: owner and agent state live in the temp dir.
const baseEnv = { ...process.env, MCPCUT_DATA_DIR: dataDir }
delete baseEnv.MCP_ADMIN_TOKEN
delete baseEnv.MCP_AGENT_TOKEN

/** Pull a token of the given prefix out of CLI output without ever recording the output. */
const tokenOf = (output, prefix) => output.match(new RegExp(`${prefix}[A-Za-z0-9_-]+`))?.[0]

/** A tool call that must be refused with a `files:` rule and must not leak the content. */
async function expectRefused(agent, tool, args, leak) {
  const res = await agent.call(tool, args)
  const ok = res.error !== null && /refused/.test(res.error.message) && res.rule.startsWith('files:') && !res.raw.includes(leak)
  return { ok, detail: ok ? `refused: ${res.rule}` : `NOT refused as expected: ${res.raw.slice(0, 400)}` }
}

/** Which volume the files live on, so a network-disk run is recognisable in the results. */
function volumeInfo() {
  if (PLATFORM === 'win32') return `path ${area}`
  const df = shell(`df -P "${area}"`, work).out.trim().split('\n').pop()
  const mount = shell(PLATFORM === 'darwin' ? 'mount' : 'mount', work).out.split('\n')
  const device = df.split(/\s+/)[0]
  const line = mount.find((l) => device && l.startsWith(`${device} `)) ?? ''
  return `path ${area}; df: ${df}; mount: ${line.trim().slice(0, 200)}`
}

async function main() {
  record('where the files live', true, `${areaRoot ? 'MCPCUT_FILES_SMOKE_DIR' : 'local tmp'}: ${volumeInfo()}`)
  const install = shell(`npm i --no-audit --no-fund --prefix "${join(work, 'pkg')}" "${TARBALL}"`, work, 300_000)
  record('npm install the packed build', install.code === 0, install.out.trim().split('\n').slice(-3).join('\n'))
  if (install.code !== 0) return
  const cliPath = join(work, 'pkg', ...CLI_PACKAGE_DIR)
  const cli = makeCli(cliPath, work, baseEnv)

  // Owner setup: the first admin of an empty store needs no token.
  const admin = cli(['admin', 'add', 'smoke-owner', '--role', 'owner'])
  const ownerToken = tokenOf(admin.out, 'mcpa_')
  record('owner: admin add (first owner, no token)', admin.code === 0 && Boolean(ownerToken), `exit ${admin.code}; token ${ownerToken ? 'minted' : 'MISSING'}`)
  if (!ownerToken) return
  const owner = (args) => cli(args, { MCP_ADMIN_TOKEN: ownerToken })

  const created = owner(['agent', 'create', AGENT])
  const agentToken = tokenOf(created.out, 'mcpj_')
  record('owner: agent create', created.code === 0 && Boolean(agentToken), `exit ${created.code}; token ${agentToken ? 'minted' : 'MISSING'}`)
  if (!agentToken) return

  // A long carve-out name so the Windows 8.3 alias (CONFID~1) differs from it.
  const longCarve = join(project, 'confidential-notes')
  mkdirSync(longCarve)
  writeFileSync(join(longCarve, 'x.txt'), SENTINEL)
  const nonAscii = join(project, 'café-priv')
  mkdirSync(nonAscii)
  writeFileSync(join(nonAscii, 'x.txt'), SENTINEL)
  const setup = [
    ['root', 'add', project],
    ['grant', AGENT, project, '--ops', 'read,write,edit,delete'],
    ['grant', AGENT, privateDir, '--ops', 'none'],
    ['grant', AGENT, longCarve, '--ops', 'none'],
    ['grant', AGENT, nonAscii, '--ops', 'none'],
  ].map((args) => ({ args, r: owner(['files', ...args]) }))
  const bad = setup.filter((s) => s.r.code !== 0)
  record('owner: files root add + grant read,write,edit,delete + carve-outs', bad.length === 0,
    bad.length ? bad.map((s) => `files ${s.args.join(' ')} -> ${s.r.out.trim().slice(0, 200)}`).join('\n') : `${setup.length} commands exit 0`)

  const agent = openClient(process.execPath, [cliPath, 'connect', 'files', '--agent', AGENT], work, { ...baseEnv, MCP_AGENT_TOKEN: agentToken })
  try {
    await agentSteps(agent, owner)
  } finally {
    const code = await agent.close()
    record('agent session closes cleanly on stdin end', code === 0, `connect exited ${code}`)
  }
  auditAndTrashSteps(owner)
}

async function agentSteps(agent, owner) {
  const names = await agent.handshake().catch((error) => { record('agent: connect + initialize', false, error.message); return [] })
  if (names.length === 0) return
  const expected = ['list_roots', 'list_directory', 'read_file', 'write_file', 'edit_file', 'move_file', 'delete_file']
  const missing = expected.filter((n) => !names.includes(n))
  record('agent: tools/list shows the file tools', missing.length === 0, `${names.length} tools: ${names.join(', ')}${missing.length ? `\nMISSING ${missing.join(', ')}` : ''}`)

  const a = join(project, 'a.txt')
  const moved = join(project, 'sub', 'b.txt')
  await step('agent: write_file', async () => {
    const r = await agent.call('write_file', { path: a, content: 'line one\n' })
    return { ok: !r.error && !r.isError && existsSync(a), detail: r.text.slice(0, 200) }
  })
  await step('agent: read_file returns the content', async () => {
    const r = await agent.call('read_file', { path: a })
    return { ok: !r.error && r.text.includes('line one'), detail: r.text.slice(0, 200) }
  })
  await step('agent: edit_file', async () => {
    const r = await agent.call('edit_file', { path: a, edits: [{ oldText: 'one', newText: 'two' }] })
    const onDisk = readFileSync(a, 'utf8')
    return { ok: !r.error && !r.isError && onDisk === 'line two\n', detail: `on disk: ${JSON.stringify(onDisk)}; ${r.text.slice(0, 120)}` }
  })
  await step('agent: list_directory shows the file', async () => {
    const r = await agent.call('list_directory', { path: project })
    return { ok: !r.error && r.text.includes('a.txt'), detail: r.text.slice(0, 300) }
  })
  await step('agent: create_directory + move_file', async () => {
    const dir = await agent.call('create_directory', { path: join(project, 'sub') })
    const r = await agent.call('move_file', { source: a, destination: moved })
    return { ok: !dir.error && !r.error && existsSync(moved) && !existsSync(a), detail: `${dir.text.slice(0, 80)} | ${r.text.slice(0, 160)}` }
  })
  await step('agent: delete_file goes to the trash (no confirmation asked)', async () => {
    const r = await agent.call('delete_file', { path: moved })
    return { ok: !r.error && !r.isError && /trash/i.test(r.text) && !existsSync(moved), detail: r.text.slice(0, 250) }
  })

  const refusals = [
    ['read outside the roots', 'read_file', { path: outsideFile }, OUTSIDE_SENTINEL],
    ['read inside the carved-out folder', 'read_file', { path: join(privateDir, 'x.txt') }, SENTINEL],
    ['write through a .. path', 'write_file', { path: `${project}${PLATFORM === 'win32' ? '\\' : '/'}..${PLATFORM === 'win32' ? '\\' : '/'}escaped.txt`, content: 'x' }, 'zzz-no-content'],
  ]
  for (const [label, tool, args, leak] of refusals) await step(`refused: ${label}`, () => expectRefused(agent, tool, args, leak))
  if (existsSync(join(area, 'escaped.txt'))) record('refused: the .. write left no file behind', false, join(area, 'escaped.txt'))

  await symlinkStep(agent)
  if (PLATFORM === 'win32') await windowsSteps(agent)
  if (PLATFORM === 'darwin') await macSteps(agent)
  if (PLATFORM === 'linux') await linuxSteps(agent)
}

/** A link made by the script (not the agent) inside the project that points outside it. */
async function symlinkStep(agent) {
  const outsideDir = join(area, 'outside-dir')
  mkdirSync(outsideDir)
  writeFileSync(join(outsideDir, 'secret.txt'), OUTSIDE_SENTINEL)
  const link = join(project, 'link-out')
  try {
    symlinkSync(outsideDir, link, 'dir')
  } catch (error) {
    record('refused: symlink inside the project pointing outside', true, `skipped: cannot create symlinks here (${error.code ?? error.message})`)
    return
  }
  await step('refused: read through a symlink pointing outside', () => expectRefused(agent, 'read_file', { path: join(link, 'secret.txt') }, OUTSIDE_SENTINEL))
  await step('refused: write through a symlink pointing outside', async () => {
    const outcome = await expectRefused(agent, 'write_file', { path: join(link, 'planted.txt'), content: 'planted' }, 'zzz-no-content')
    return { ok: outcome.ok && !existsSync(join(outsideDir, 'planted.txt')), detail: outcome.detail }
  })
}

async function windowsSteps(agent) {
  for (const [label, name] of [['reserved device name CON', 'CON'], ['reserved device name NUL.txt', 'NUL.txt'], ['alternate data stream note.txt:hidden', 'note.txt:hidden']]) {
    await step(`refused (Windows): ${label}`, () => expectRefused(agent, 'write_file', { path: join(project, name), content: 'x' }, 'zzz-no-content'))
  }
  await step('refused (Windows): 8.3 short name of a carved-out folder', async () => {
    const long = join(project, 'confidential-notes')
    const short = shell(`cmd /c for %I in ("${long}") do @echo %~sI`, work).out.trim().split(/\r?\n/).pop() ?? ''
    if (!short || short.toLowerCase() === long.toLowerCase()) return { ok: true, detail: `n/a: this volume has no 8.3 short name for it (got "${short}")` }
    const outcome = await expectRefused(agent, 'read_file', { path: join(short, 'x.txt') }, SENTINEL)
    return { ok: outcome.ok, detail: `${short}: ${outcome.detail}` }
  })
}

/** True when a name differing only in case reaches the same folder. */
const isCaseInsensitive = () => existsSync(join(project, 'PRIVATE'))

async function macSteps(agent) {
  await step('refused (macOS): case alias PRIVATE/x.txt of a carved-out folder', async () => {
    if (!isCaseInsensitive()) return { ok: true, detail: 'n/a: this volume is case-sensitive, PRIVATE is a different folder' }
    return expectRefused(agent, 'read_file', { path: join(project, 'PRIVATE', 'x.txt') }, SENTINEL)
  })
  await step('refused (macOS): NFD alias of a non-ASCII carved-out folder', async () => {
    const nfd = join(project, 'café-priv'.normalize('NFD'), 'x.txt')
    if (!existsSync(nfd)) return { ok: true, detail: 'n/a: this file system does not fold NFD to NFC' }
    return expectRefused(agent, 'read_file', { path: nfd }, SENTINEL)
  })
}

/** On a case-sensitive file system PRIVATE is its own folder: granted, readable, no false refusal. */
async function linuxSteps(agent) {
  await step('no false refusal (Linux): a real PRIVATE folder is a different folder and readable', async () => {
    if (isCaseInsensitive()) return { ok: true, detail: 'n/a: this volume is case-insensitive' }
    const upper = join(project, 'PRIVATE')
    mkdirSync(upper)
    writeFileSync(join(upper, 'x.txt'), 'upper-case folder content')
    const r = await agent.call('read_file', { path: join(upper, 'x.txt') })
    const still = await expectRefused(agent, 'read_file', { path: join(privateDir, 'x.txt') }, SENTINEL)
    return { ok: !r.error && r.text.includes('upper-case folder content') && still.ok, detail: `PRIVATE read: ${r.text.slice(0, 80)}; private/ still: ${still.detail}` }
  })
}

function auditAndTrashSteps(owner) {
  const moved = join(project, 'sub', 'b.txt')
  const listed = owner(['files', 'trash', 'list', project])
  const id = listed.out.match(ULID)?.[0]
  record('trash list shows the deleted file', listed.code === 0 && Boolean(id) && listed.out.includes('b.txt'), listed.out.trim().split('\n').slice(0, 3).join('\n'))
  if (id) {
    const restored = owner(['files', 'trash', 'restore', project, id])
    const back = existsSync(moved) ? readFileSync(moved, 'utf8') : null
    record('trash restore brings it back with the same content', restored.code === 0 && back === 'line two\n', `exit ${restored.code}; content ${JSON.stringify(back)}`)
  } else {
    record('trash restore brings it back with the same content', false, 'no trash id to restore')
  }

  const audit = owner(['files', 'audit', '--json', '--limit', '200'])
  let entries = []
  try { entries = JSON.parse(audit.stdout.trim()).entries ?? [] } catch { /* reported below */ }
  const mine = entries.filter((e) => e.actor?.name === AGENT)
  const allowed = new Set(mine.filter((e) => e.outcome === 'allow').map((e) => e.action))
  const denied = mine.filter((e) => e.outcome === 'deny' && String(e.rule).startsWith('files:'))
  const needed = ['write_file', 'read_file', 'edit_file', 'move_file', 'delete_file']
  const missing = needed.filter((n) => !allowed.has(n))
  record('audit --json lists the agent calls and the refusals with a reason',
    audit.code === 0 && missing.length === 0 && denied.length >= 3,
    `${mine.length} agent entries; allowed: ${[...allowed].join(',')}; ${denied.length} refusals, e.g. ${denied[0]?.rule?.slice(0, 80) ?? 'none'}${missing.length ? `\nMISSING allowed ${missing.join(',')}` : ''}`)
}

try {
  await main()
} catch (error) {
  record('smoke run', false, `threw: ${error instanceof Error ? error.stack ?? error.message : error}`)
}

const failed = results.filter((r) => !r.ok)
writeResults('files', { platform: PLATFORM, node: process.version, source: 'local build', filesDir: area, volume: volumeInfo() })
console.log(`\n${results.length - failed.length}/${results.length} steps passed on ${PLATFORM} (file module)`)
if (failed.length === 0) for (const dir of new Set([work, area])) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
else console.log(`work dir kept for inspection: ${work}`)
process.exit(failed.length === 0 ? 0 : 1)
