import { spawn } from 'node:child_process'
import type { NpmInvocation } from './files-db-seams.js'

/**
 * Running npm for `files setup` and `files setup --search`: the arguments are
 * constants — nothing the user typed reaches the command line.
 */

export const MODULES_DIR_MODE = 0o700
const NPM_ARGS = ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier'] as const

/** `npm` on POSIX; `npm.cmd` through a shell on Windows, where it is a batch file. */
export function npmInvocationOf(cwd: string, platform: NodeJS.Platform): NpmInvocation {
  const isWindows = platform === 'win32'
  return { command: isWindows ? 'npm.cmd' : 'npm', args: NPM_ARGS, cwd, shell: isWindows }
}

export function spawnNpm(invocation: NpmInvocation): Promise<number> {
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
