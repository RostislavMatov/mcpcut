#!/usr/bin/env node
// Reproducible state-store benchmark behind ADR-0006 (Evidence table).
// Compares, over the REAL modules from dist/:
//
//   1. the store seam (`createJsonStore`: SQLite-backed since M4.5 wave 2)
//   2. SQLite WAL (`openSqlite`: BEGIN IMMEDIATE transaction per update)
//
// measuring update throughput (optionally across N competing processes —
// the measurement that showed 8 processes achieve the same total throughput
// as 1) and read throughput (the per-HTTP-request / revocation-poll path).
//
// Usage:
//   npm run build
//   node tools/bench/bench-state.mjs [--updates 2000] [--reads 2000] [--agents 200] [--procs 1]
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createJsonStore } from '../../dist/policy/store.js'
import { openSqlite } from '../../dist/store/sqlite.js'

const SCRIPT_PATH = fileURLToPath(import.meta.url)

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    updates: { type: 'string', default: '2000' },
    reads: { type: 'string', default: '2000' },
    agents: { type: 'string', default: '200' },
    procs: { type: 'string', default: '1' },
    worker: { type: 'string' },
  },
})
const UPDATES = Number(args.updates)
const READS = Number(args.reads)
const AGENTS = Number(args.agents)
const PROCS = Number(args.procs)

/** Builds a state document shaped like agents.json: N agents with grants. */
function makeState(agentCount) {
  const agents = {}
  for (let i = 0; i < agentCount; i += 1) {
    agents[`agent-${i}`] = {
      tokenHash: `hash-${i}-0000000000000000000000000000000000000000`,
      createdAt: '2026-08-13T00:00:00.000Z',
      revoked: false,
      grants: [
        { server: 'filesystem', tool: 'read_file' },
        { server: 'filesystem', tool: 'search_files' },
      ],
      counter: 0,
    }
  }
  return { agents }
}

function report(label, count, elapsedMs, unit) {
  const perSec = Math.round((count / elapsedMs) * 1000)
  console.log(`${label.padEnd(46)} ${String(perSec).padStart(9)} ${unit}  (${count} ops, ${Math.round(elapsedMs)} ms)`)
}

// -- store seam (createJsonStore, SQLite-backed) -----------------------

async function jsonUpdateLoop(filePath, iterations) {
  const store = createJsonStore(filePath, { validate: (raw) => raw, defaultValue: {} })
  for (let i = 0; i < iterations; i += 1) {
    await store.update((current) => {
      const name = `agent-${i % AGENTS}`
      const agent = current.agents[name]
      return {
        ...current,
        agents: { ...current.agents, [name]: { ...agent, counter: agent.counter + 1 } },
      }
    })
  }
}

async function benchJsonStore(dir) {
  const filePath = join(dir, 'agents.json')
  const store = createJsonStore(filePath, { validate: (raw) => raw, defaultValue: {} })
  await store.update(() => makeState(AGENTS))

  const start = performance.now()
  if (PROCS === 1) {
    await jsonUpdateLoop(filePath, UPDATES)
  } else {
    await runWorkers('json-update', filePath)
  }
  report(`store seam update, ${AGENTS} agents, ${PROCS} proc(s)`, UPDATES, performance.now() - start, 'upd/s')

  const readStart = performance.now()
  for (let i = 0; i < READS; i += 1) {
    await store.read()
  }
  report(`store seam read (document + validate)`, READS, performance.now() - readStart, ' rd/s')
}

// -- SQLite (ADR-0006) --------------------------------------------------

const AGENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS agents (
    name    TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0
  )`

async function sqliteUpdateLoop(dbPath, iterations) {
  const handle = await openSqlite(dbPath, { synchronous: 'normal' })
  const select = handle.db.prepare('SELECT counter FROM agents WHERE name = ?')
  const update = handle.db.prepare('UPDATE agents SET counter = ? WHERE name = ?')
  for (let i = 0; i < iterations; i += 1) {
    const name = `agent-${i % AGENTS}`
    handle.transaction(() => {
      const row = select.get(name)
      if (row === undefined) throw new Error(`agent "${name}" is not seeded — check --agents`)
      update.run(row.counter + 1, name)
    })
  }
  handle.close()
}

async function benchSqlite(dir) {
  const dbPath = join(dir, 'state.db')
  const handle = await openSqlite(dbPath, { synchronous: 'normal' })
  handle.db.exec(AGENTS_TABLE)
  const insert = handle.db.prepare('INSERT INTO agents (name, data, counter) VALUES (?, ?, 0)')
  const state = makeState(AGENTS)
  handle.transaction(() => {
    for (const [name, agent] of Object.entries(state.agents)) {
      insert.run(name, JSON.stringify(agent))
    }
  })

  const start = performance.now()
  if (PROCS === 1) {
    await sqliteUpdateLoop(dbPath, UPDATES)
  } else {
    await runWorkers('sqlite-update', dbPath)
  }
  report(`SQLite update (txn CAS), ${AGENTS} agents, ${PROCS} proc(s)`, UPDATES, performance.now() - start, 'upd/s')

  const select = handle.db.prepare('SELECT data, counter FROM agents WHERE name = ?')
  const readStart = performance.now()
  for (let i = 0; i < READS; i += 1) {
    select.get(`agent-${i % AGENTS}`)
  }
  report(`SQLite read (indexed, one agent)`, READS, performance.now() - readStart, ' rd/s')
  handle.close()
}

// -- multi-process harness ---------------------------------------------

/** Spawns PROCS copies of this script in worker mode, splitting UPDATES between them. */
function runWorkers(mode, targetPath) {
  const perWorker = Math.ceil(UPDATES / PROCS)
  const workers = Array.from({ length: PROCS }, () => {
    const child = spawn(
      process.execPath,
      [SCRIPT_PATH, '--worker', mode, '--updates', String(perWorker), '--agents', String(AGENTS), targetPath],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )
    return new Promise((resolve, reject) => {
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`worker exited with code ${code}`)),
      )
      child.on('error', reject)
    })
  })
  return Promise.all(workers)
}

async function runAsWorker(mode, targetPath) {
  if (mode === 'json-update') {
    await jsonUpdateLoop(targetPath, UPDATES)
    return
  }
  if (mode === 'sqlite-update') {
    await sqliteUpdateLoop(targetPath, UPDATES)
    return
  }
  throw new Error(`unknown worker mode: ${mode}`)
}

// -- main ---------------------------------------------------------------

if (args.worker !== undefined) {
  await runAsWorker(args.worker, positionals[0])
} else {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-state-bench-'))
  try {
    console.log(`state bench: ${UPDATES} updates, ${READS} reads, ${AGENTS} agents, ${PROCS} proc(s), node ${process.version}\n`)
    await benchJsonStore(dir)
    await benchSqlite(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
