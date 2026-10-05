import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import { PG_PACKAGE_VERSION } from '../files/db/constants.js'
import { MODULES_PACKAGE_JSON, MODULES_PACKAGE_LOCK } from '../files/db/modules-lock.js'
import { loadPg, modulesDirOf } from '../files/db/pg-loader.js'
import { formatReadableField } from '../journal/format.js'
import type { AgentCliIo } from './agent-cmd.js'
import type { FilesCliOptions } from './files-cmd.js'
import type { NpmInvocation } from './files-db-seams.js'
import { cliCommand } from './next-step.js'

/**
 * `mcpcut files setup` (ADR-0020 §7): installs the pinned Postgres client
 * into `<data dir>/modules` from a lockfile that ships inside mcpcut. It
 * writes nothing of mcpcut's own state, so no token. The npm arguments are
 * constants — nothing the user typed reaches the command line.
 */

const MODULES_DIR_MODE = 0o700
const NPM_ARGS = ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'] as const

/** `npm` on POSIX; `npm.cmd` through a shell on Windows, where it is a batch file. */
export function npmInvocationOf(cwd: string, platform: NodeJS.Platform): NpmInvocation {
  const isWindows = platform === 'win32'
  return { command: isWindows ? 'npm.cmd' : 'npm', args: NPM_ARGS, cwd, shell: isWindows }
}

function spawnNpm(invocation: NpmInvocation): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      stdio: 'inherit',
      shell: invocation.shell,
    })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

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

export async function runSetup(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const cli = cliCommand(opts.env)
  if (args.length > 0) {
    io.stderr.write(`usage: ${cli} files setup\n`)
    return 1
  }
  const modulesDir = modulesDirOf(opts.journalDir ?? JOURNAL_DIR)
  const where = formatReadableField(modulesDir)
  if ((await installedPgVersion(modulesDir)) === PG_PACKAGE_VERSION) {
    io.stdout.write(`Postgres client pg ${PG_PACKAGE_VERSION} is already installed in ${where}\n`)
    io.stderr.write(`Next: ${cli} files db init\n`)
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
  io.stderr.write(`Next: ${cli} files db init\n`)
  return 0
}
