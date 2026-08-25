import type { EffectiveToolInput } from '../policy/effective.js'
import { createInventory } from '../policy/inventory.js'
import { openInventoryStore } from '../policy/inventory-store.js'
import type { ToolDescriptor } from '../protocol/mcp.js'
import type { PolicyCliIo } from './policy-cmd.js'

/**
 * The inventory side of `policy set`'s "effective now" line: what the gate
 * would know about the tool (quarantine state, surface delta, stored
 * descriptor for classification) — read the way `quarantine list` reads it,
 * through the shared inventory store.
 *
 * Display-only, and it runs AFTER the file is written: nothing here may fail
 * the command. An unreadable inventory degrades to the bare-name view (the
 * catalog fallback the gate itself uses when no descriptor is stored) with
 * one line on stderr.
 *
 * A tool the inventory has never seen is reported as `'known'`, not
 * `'unknown'`: `decide()` treats `'unknown'` + an observed catalog as a
 * shadow tool and answers `deny`, which would be the wrong thing to print
 * for a rule written ahead of the server's first `tools/list`. Once the
 * proxy observes the tool it is quarantined the normal way, and the next
 * `policy set` reports that.
 */

type ToolFacts = EffectiveToolInput['tool']

/** The stored descriptor, approved first, else the quarantined copy; `undefined` when neither exists. */
async function storedDescriptorOf(
  storePath: string,
  serverName: string,
  toolName: string,
): Promise<ToolDescriptor | undefined> {
  const data = await openInventoryStore(storePath).read()
  const entry = Object.hasOwn(data.servers, serverName) ? data.servers[serverName] : undefined
  if (entry === undefined) return undefined
  const approved = Object.hasOwn(entry.approved, toolName) ? entry.approved[toolName] : undefined
  if (approved?.descriptor !== undefined) return approved.descriptor
  const quarantined = Object.hasOwn(entry.quarantined, toolName) ? entry.quarantined[toolName] : undefined
  return quarantined?.descriptor
}

async function readFacts(storePath: string, serverName: string, toolName: string): Promise<ToolFacts> {
  const inventory = createInventory(serverName, { storePath })
  await inventory.load()
  const state = inventory.stateOf(toolName)
  const surfaceDelta = inventory.surfaceDeltaOf(toolName)
  const descriptor = await storedDescriptorOf(storePath, serverName, toolName)
  return {
    name: toolName,
    quarantineState: state === 'unknown' ? 'known' : state,
    ...(descriptor !== undefined ? { descriptor } : {}),
    ...(surfaceDelta !== undefined ? { surfaceDelta } : {}),
  }
}

/** Facts for `effectiveToolRule`; never throws — falls back to the bare-name view with a diagnostic. */
export async function toolFactsForEffectiveRule(
  storePath: string,
  serverName: string,
  toolName: string,
  io: PolicyCliIo,
): Promise<ToolFacts> {
  try {
    return await readFacts(storePath, serverName, toolName)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr.write(`[inventory] could not read the tool inventory for the effective-outcome line: ${message}\n`)
    return { name: toolName, quarantineState: 'known' }
  }
}
