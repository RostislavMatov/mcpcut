import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import { PG_PACKAGE_VERSION } from '../files/db/constants.js'
import { MODULES_PACKAGE_JSON, MODULES_PACKAGE_LOCK } from '../files/db/modules-lock.js'
import { loadPg, modulesDirOf } from '../files/db/pg-loader.js'
import { formatReadableField } from '../journal/format.js'
import type { AgentCliIo } from './agent-cmd.js'
import type { FilesCliOptions } from './files-cmd.js'
import { MODULES_DIR_MODE, npmInvocationOf, spawnNpm } from './files-npm.js'
import { runSetupSearch } from './files-cmd-setup-search.js'
import { cliCommand } from './next-step.js'

/**
 * `mcpcut files setup` (ADR-0020 §7): installs the pinned Postgres client
 * into `<data dir>/modules` from a lockfile that ships inside mcpcut. It
 * writes nothing of mcpcut's own state, so no token. The npm arguments are
 * constants — nothing the user typed reaches the command line.
 */

/** The pg version installed in the modules folder, or undefined. */
export async function installedPgVersion(modulesDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(modulesDir, 'node_modules', 'pg', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

async function writePinnedFiles(modulesDir: string): Promise<void> {
  await mkdir(modulesDir, { recursive: true, mode: MODULES_DIR_MODE })
  await chmod(modulesDir, MODULES_DIR_MODE)
  await writeFile(join(modulesDir, 'package.json'), `${JSON.stringify(MODULES_PACKAGE_JSON, null, 2)}\n`)
  await writeFile(join(modulesDir, 'package-lock.json'), `${JSON.stringify(MODULES_PACKAGE_LOCK, null, 2)}\n`)
}

const SETUP_USAGE = 'files setup [--search]'
const SEARCH_OPTIONAL_LINE = (cli: string): string => `Optional: \`${cli} files setup --search\` adds search by meaning (downloads ≈ 430 MB)\n`

/** The Postgres client part: 0 when pg is in place (already or just installed), else the exit code to return. */
async function ensurePgClient(io: AgentCliIo, opts: FilesCliOptions, cli: string, modulesDir: string): Promise<number> {
  const where = formatReadableField(modulesDir)
  if ((await installedPgVersion(modulesDir)) === PG_PACKAGE_VERSION) {
    io.stdout.write(`Postgres client pg ${PG_PACKAGE_VERSION} is already installed in ${where}\n`)
    return 0
  }
  const platform = opts.db?.platform ?? process.platform
  const runNpm = opts.db?.runNpm ?? spawnNpm
  await writePinnedFiles(modulesDir)
  io.stdout.write(`installing the Postgres client pg ${PG_PACKAGE_VERSION} into ${where}\n`)
  const retry = `check your network and run \`${cli} files setup\` again`
  const code = await runNpm(npmInvocationOf(modulesDir, platform)).catch((error: unknown) => {
    io.stderr.write(`could not run npm (${formatReadableField(error instanceof Error ? error.message : String(error))}): install Node.js with npm, then run \`${cli} files setup\` again\n`)
    return undefined
  })
  if (code === undefined) return 1
  if (code !== 0) {
    io.stderr.write(`npm exited with code ${code}: ${retry}\n`)
    return 1
  }
  try {
    await (opts.db?.loadPg ?? loadPg)(modulesDir)
  } catch (error: unknown) {
    io.stderr.write(`the client was installed but cannot be loaded (${formatReadableField(error instanceof Error ? error.message : String(error))}): ${retry}\n`)
    return 1
  }
  io.stdout.write(`installed pg ${PG_PACKAGE_VERSION} in ${where}\n`)
  return 0
}

export async function runSetup(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const cli = cliCommand(opts.env)
  const isSearch = args.length === 1 && args[0] === '--search'
  if (args.length > 0 && !isSearch) {
    io.stderr.write(`usage: ${cli} ${SETUP_USAGE}\n`)
    return 1
  }
  const modulesDir = modulesDirOf(opts.journalDir ?? JOURNAL_DIR)
  const pgCode = await ensurePgClient(io, opts, cli, modulesDir)
  if (pgCode !== 0) return pgCode
  if (isSearch) return runSetupSearch(io, opts, { cli, modulesDir })
  io.stdout.write(SEARCH_OPTIONAL_LINE(cli))
  io.stderr.write(`Next: ${cli} files db init\n`)
  return 0
}
