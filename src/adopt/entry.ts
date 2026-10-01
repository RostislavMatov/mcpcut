import { CLI_NAME } from '../setup/constants.js'

/**
 * `mcpcut adopt` (P3), one server entry of a client's config: is it a stdio
 * server we can put behind `wrap`, and what does it look like then. Pure —
 * reading and writing the files is `apply.ts`'s job — and immutable: the
 * entry handed in is never changed, the wrapped one is a new object that
 * keeps every field but `command` and `args` (env, cwd, type, unknown keys).
 */

/** How a client starts mcpcut: the pinned package through npx, as the README's Quick start does. */
export interface Launcher {
  readonly command: string
  readonly args: readonly string[]
}

export type EntryVerdict =
  | { readonly kind: 'wrap'; readonly next: Readonly<Record<string, unknown>> }
  /** Already starts mcpcut (`wrap` or the `connect` bridge): wrapping twice would journal twice. */
  | { readonly kind: 'already' }
  /** A server the client dials by URL; `wrap` sits between a client and a process it starts. */
  | { readonly kind: 'remote' }
  /** Not a shape we understand; left exactly as it is. */
  | { readonly kind: 'unreadable' }
  /**
   * Windows only: the wrapped line runs through `cmd /c`, which would read
   * `& | ^ < > % ! "` in the name or an argument as its own syntax (a
   * connection string's `&b=2` would run `b=2`). Left for the user to wrap by hand.
   */
  | { readonly kind: 'cmd-unsafe' }

const NPX_COMMAND = 'npx'
const NPX_YES_FLAG = '-y'
const WINDOWS_SHELL = ['cmd', '/c'] as const
const WRAP_VERB = 'wrap'
const SERVER_FLAG = '--server'
const END_OF_OPTIONS = '--'

/** Keys a client uses for a server it dials instead of starting. */
const REMOTE_KEYS: readonly string[] = ['url', 'serverUrl']
const REMOTE_TYPES: readonly string[] = ['http', 'sse', 'streamable-http', 'streamableHttp']

/**
 * npm-family commands are `.cmd` shims on Windows, which a process spawned
 * without a shell cannot start (`spawn npx ENOENT`, smoke of 0.2.4 on
 * Windows); `wrap` spawns without one, so they go through `cmd /c`.
 */
const WINDOWS_SHIM_NAMES: readonly string[] = ['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx']
const WINDOWS_SCRIPT_EXTENSION = /\.(cmd|bat)$/i
const WINDOWS_EXTENSION = /\.(cmd|bat|exe|com)$/i

/** What `cmd /c` treats as syntax rather than text. */
const CMD_SYNTAX = /[&|^<>%!"\r\n]/

/** `mcpcut` or `mcpcut@<version>` — not `mcpcut-themes`. */
const MCPCUT_PACKAGE_ARG = new RegExp(`^${CLI_NAME}(@\\S+)?$`)

export function launcherOf(version: string, platform: NodeJS.Platform): Launcher {
  const npx = [NPX_COMMAND, NPX_YES_FLAG, `${CLI_NAME}@${version}`]
  if (platform === 'win32') return { command: WINDOWS_SHELL[0], args: [WINDOWS_SHELL[1], ...npx] }
  return { command: npx[0] ?? NPX_COMMAND, args: npx.slice(1) }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** The file name without directories or a Windows extension, lower-cased: `C:\x\Npx.CMD` → `npx`. */
function commandName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command
  return base.replace(WINDOWS_EXTENSION, '').toLowerCase()
}

function isRemote(entry: Readonly<Record<string, unknown>>): boolean {
  if (REMOTE_KEYS.some((key) => typeof entry[key] === 'string')) return true
  return typeof entry['type'] === 'string' && REMOTE_TYPES.includes(entry['type'])
}

function startsMcpcut(command: string, args: readonly string[]): boolean {
  return commandName(command) === CLI_NAME || args.some((arg) => MCPCUT_PACKAGE_ARG.test(arg))
}

function needsWindowsShell(command: string): boolean {
  const name = commandName(command)
  if (name === WINDOWS_SHELL[0]) return false
  return WINDOWS_SHIM_NAMES.includes(name) || WINDOWS_SCRIPT_EXTENSION.test(command)
}

/** The server's own command line as `wrap` will spawn it. */
function innerCommand(command: string, args: readonly string[], platform: NodeJS.Platform): readonly string[] {
  const line = [command, ...args]
  return platform === 'win32' && needsWindowsShell(command) ? [...WINDOWS_SHELL, ...line] : line
}

export function adoptEntry(name: string, entry: unknown, launcher: Launcher, platform: NodeJS.Platform): EntryVerdict {
  if (!isRecord(entry)) return { kind: 'unreadable' }
  if (isRemote(entry)) return { kind: 'remote' }
  const command = entry['command']
  const args = entry['args'] ?? []
  if (typeof command !== 'string' || command.trim() === '' || !isStringList(args)) return { kind: 'unreadable' }
  if (startsMcpcut(command, args)) return { kind: 'already' }
  if (platform === 'win32' && [name, command, ...args].some((part) => CMD_SYNTAX.test(part))) return { kind: 'cmd-unsafe' }
  return {
    kind: 'wrap',
    next: {
      ...entry,
      command: launcher.command,
      args: [...launcher.args, WRAP_VERB, SERVER_FLAG, name, END_OF_OPTIONS, ...innerCommand(command, args, platform)],
    },
  }
}
