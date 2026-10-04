import { FILES_SERVER_NAME } from '../files/constants.js'
import { formatReadableField } from '../journal/format.js'
import { DuplicateServerError } from '../registry/store.js'
import type { RegistryStore } from '../registry/store.js'
import { cliCommand } from './next-step.js'

/**
 * The registry side of `mcpcut files` (ADR-0020 §1): the file module is the
 * built-in server named `files`. `root add` makes sure it is registered;
 * `grant` needs it. A server of another kind under that name is a conflict
 * the admin resolves, never overwritten.
 */

type RegistryReader = Pick<RegistryStore, 'getServer'>
type RegistryWriter = Pick<RegistryStore, 'getServer' | 'addServer'>

export type FilesServerState = 'builtin' | 'missing' | 'conflict'

export async function filesServerState(registry: RegistryReader): Promise<FilesServerState> {
  const record = await registry.getServer(FILES_SERVER_NAME)
  if (record === undefined) return 'missing'
  return record.transport === 'builtin' ? 'builtin' : 'conflict'
}

/** One line: another server holds the name, here is how to free it. */
export function conflictMessage(env: NodeJS.ProcessEnv | undefined): string {
  return (
    `a server named "${formatReadableField(FILES_SERVER_NAME)}" is already registered and is not the built-in file server: ` +
    `remove it with \`${cliCommand(env)} server remove ${FILES_SERVER_NAME}\`, then run this again`
  )
}

/** One line: the built-in server is not registered; `root add` registers it. */
export function notRegisteredMessage(env: NodeJS.ProcessEnv | undefined, folder: string): string {
  return `the built-in file server is not registered yet: run \`${cliCommand(env)} files root add ${folder}\` first`
}

/** Registers the built-in `files` server when absent; `added` says whether this call did it. */
export async function registerFilesServer(registry: RegistryWriter): Promise<{ readonly added: boolean }> {
  if ((await filesServerState(registry)) === 'builtin') return { added: false }
  try {
    await registry.addServer({ name: FILES_SERVER_NAME, transport: 'builtin', kind: 'files' })
    return { added: true }
  } catch (error: unknown) {
    // A concurrent `root add` registered it between our read and our write.
    if (error instanceof DuplicateServerError && (await filesServerState(registry)) === 'builtin') return { added: false }
    throw error
  }
}
