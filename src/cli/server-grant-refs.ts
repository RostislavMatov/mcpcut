import { createAgentsStore } from '../agents/store.js'
import { createGroupsStore } from '../groups/store.js'
import { formatReadableField } from '../journal/format.js'
import type { ServerCliIo, ServerCliOptions } from './server-cmd.js'

/**
 * Who still points at a server NAME (as opposed to a server record). The
 * registry and the two grant documents share no transaction, so a name can
 * outlive its registration — after a crashed cascade, or after a `remove`
 * whose groups half failed. Registering the name again silently hands those
 * old grantees access to whatever the name now points at, which is the M3a
 * threat this module exists to make visible.
 *
 * Read-only and best effort: `server add` has already written the record when
 * this runs, so nothing here may turn the command into a failure.
 */

/** How many agents and groups grant a given server name. */
export interface GrantReferenceCount {
  readonly agents: number
  readonly groups: number
}

function storeOptionsOf(opts: ServerCliOptions): { journalDir?: string } {
  return opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}
}

/** Counts the agents and groups whose grants name `server`. */
export async function countGrantReferences(
  server: string,
  opts: ServerCliOptions,
): Promise<GrantReferenceCount> {
  const storeOpts = storeOptionsOf(opts)
  const agents = await createAgentsStore(storeOpts).listAgents()
  const groups = await createGroupsStore(storeOpts).listGroups()
  return {
    agents: agents.filter((agent) => Object.hasOwn(agent.grants, server)).length,
    groups: groups.filter((group) => Object.hasOwn(group.grants, server)).length,
  }
}

/**
 * Warns once, on stderr, when a freshly registered name was already granted.
 * A failure to look is reported and swallowed: the record is written, and a
 * missing warning must not become a failed `server add`.
 */
export async function warnAboutExistingGrants(
  server: string,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<void> {
  let counts: GrantReferenceCount
  try {
    counts = await countGrantReferences(server, opts)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    io.stderr.write(`[warn] could not check existing grants for "${formatReadableField(server)}": ${reason}\n`)
    return
  }
  if (counts.agents === 0 && counts.groups === 0) return
  io.stderr.write(
    `[warn] "${formatReadableField(server)}" is already granted to ${counts.agents} agents ` +
      `and ${counts.groups} groups from an earlier registration ` +
      `— review with agent list / group list\n`,
  )
}
