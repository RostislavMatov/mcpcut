import type { EffectiveAgentLister } from '../agents/effective-reader.js'
import { desiredResidentPairs } from '../pool/residents.js'
import type { StdioServerRecord } from '../registry/schema.js'
import type { RegistryStore } from '../registry/store.js'
import type { ServeWritable } from './serve-constants.js'
import type { ResidentSupervisor } from './serve-residents.js'

/**
 * The reconcile loop of the resident supervisor (ADR-0016, RS4): every poll
 * interval it reads the effective agents and the registry, works out which
 * pairs should be resident (`src/pool/residents.ts`), and hands that to the
 * supervisor, which starts what is new and stops what left.
 *
 * The interval is the agent revocation poll's own (5 s), so "a withdrawn
 * grant stops its process within 5 s" is one number, not two.
 *
 * A failed read changes NOTHING: nothing is started and nothing is stopped
 * (the `pool/watch.ts` rule — fail closed means "no new access", not "less
 * access"), and one stderr line says why. The vault is never read here: a
 * rotated secret is caught when an agent attaches (RS4), not every 5 s.
 */

export interface ResidentReconcileDeps {
  readonly agents: EffectiveAgentLister
  readonly registry: Pick<RegistryStore, 'listServers'>
  readonly supervisor: Pick<ResidentSupervisor, 'applyDesired'>
  readonly intervalMs: number
  /** How many pairs may be resident (`MAX_POOL_RESIDENTS`, or a test's). */
  readonly cap: number
  readonly stderr: ServeWritable
}

export interface ResidentReconcile {
  /** One pass; never rejects. Overlapping calls join the pass in flight. */
  tick(): Promise<void>
  stop(): void
}

export function startResidentReconcile(deps: ResidentReconcileDeps): ResidentReconcile {
  let timer: NodeJS.Timeout | null = null
  let isStopped = false
  let inFlight: Promise<void> | null = null
  /** Pairs past the cap at the last pass; a line only when it changes. */
  let overCapCount = 0

  async function pass(): Promise<void> {
    try {
      const [agents, servers] = await Promise.all([deps.agents.listAgents(), deps.registry.listServers()])
      if (isStopped) return
      const desired = desiredResidentPairs(agents, servers, deps.cap)
      const records = new Map(
        servers.flatMap((server): Array<[string, StdioServerRecord]> =>
          server.transport === 'stdio' ? [[server.name, server]] : [],
        ),
      )
      deps.supervisor.applyDesired(desired, records)
      if (desired.overCap.length !== overCapCount) {
        overCapCount = desired.overCap.length
        deps.stderr.write(
          `[serve] residents: ${overCapCount} granted stdio server(s) over the cap of ${deps.cap}; ` +
            'they start when an agent asks\n',
        )
      }
    } catch (error: unknown) {
      deps.stderr.write(`[serve] residents: could not read agents or registry; nothing changed (${describe(error)})\n`)
    }
  }

  function tick(): Promise<void> {
    if (isStopped) return Promise.resolve()
    inFlight ??= pass().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  void tick()
  timer = setInterval(() => void tick(), deps.intervalMs)
  timer.unref()

  return {
    tick,
    stop(): void {
      isStopped = true
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}


function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
