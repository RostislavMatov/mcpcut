import type { ServerRecord } from './schema.js'

/** What a registry record points at, in words an operator reads in a list, a card or a tile. */

/** The label of the file module's built-in server (nothing to spawn, nothing to connect to). */
export const BUILTIN_FILES_LABEL = 'built-in file server'

/** The command (stdio), url (http) or built-in label of a record. */
export function targetOf(record: ServerRecord): string {
  if (record.transport === 'stdio') return record.command
  if (record.transport === 'http') return record.url
  return BUILTIN_FILES_LABEL
}

/** Whether an admin may change the record's command, args, url or headers: a built-in has none. */
export function isEditable(record: ServerRecord): boolean {
  return record.transport !== 'builtin'
}
