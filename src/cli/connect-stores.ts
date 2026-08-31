import { createEffectiveAgentReader, type EffectiveAgentReader } from '../agents/effective-reader.js'
import { createAgentsStore } from '../agents/store.js'
import { createGroupsStore } from '../groups/store.js'
import type { ServerRecord } from '../registry/schema.js'
import { createRegistryStore, type RegistryStore } from '../registry/store.js'
import { resolveVaultRefs } from '../vault/resolve.js'
import { createVaultStore } from '../vault/store.js'
import type { ConnectDeps } from './connect-cmd.js'
import type { StartConnectSessionArgs } from './connect-session.js'
import type { PrepareUpstreamArgs } from './connect-upstream.js'

/**
 * Everything `connect` needs to BUILD before it can decide anything: the
 * stores behind the effective-agent reader and the registry, and the two
 * argument bags handed to `prepareUpstream` and `startConnectSession`. Split
 * out of `connect-cmd.ts` for the file-size budget; the command keeps the
 * order of operations, this module keeps the wiring.
 *
 * Every override in `ConnectDeps` is forwarded ONLY when it was actually
 * given, so each unset knob keeps its own default rather than being
 * overwritten with `undefined`.
 */

/** The registry surface `connect` uses: two reads, matching `ConnectDeps.registryStore`. */
export type ConnectRegistryReader = Pick<RegistryStore, 'getServer' | 'listServers'>

/** The read surfaces `runConnect` resolves its caller and its target against. */
export interface ConnectStores {
  readonly agentReader: EffectiveAgentReader
  readonly registry: ConnectRegistryReader
}

export function buildConnectStores(deps: ConnectDeps): ConnectStores {
  const journalDir = deps.journalDir
  const storeOpts = journalDir !== undefined ? { journalDir } : {}
  const agents = deps.agentsStore ?? createAgentsStore(storeOpts)
  const groups = deps.groupsStore ?? createGroupsStore(storeOpts)
  // Every read of an agent record on this path — the pre-traffic checks and
  // the session's revocation watch — goes through the reader, so a grant held
  // through a group is indistinguishable from a personal one (G2/G5).
  return {
    agentReader: createEffectiveAgentReader({ agents, groups }),
    registry: deps.registryStore ?? createRegistryStore(journalDir),
  }
}

/**
 * Assembles `prepareUpstream`'s arguments, forwarding only the overrides that
 * were actually given so each keeps its own default. The vault store is built
 * here because this is the only thing that needs it: `resolveRefs` is the one
 * path a decrypted value ever travels.
 */
export function upstreamArgsOf(args: {
  readonly deps: ConnectDeps
  readonly env: NodeJS.ProcessEnv
  readonly record: ServerRecord
  readonly onDiagnostic: (line: string) => void
}): PrepareUpstreamArgs {
  const { deps } = args
  const vault = createVaultStore(deps.journalDir !== undefined ? { journalDir: deps.journalDir } : {})
  return {
    record: args.record,
    processEnv: args.env,
    resolveRefs: (record) => resolveVaultRefs(record, vault.readSecretValues),
    onDiagnostic: args.onDiagnostic,
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
    ...(deps.stderr !== undefined ? { stderr: deps.stderr } : {}),
    ...(deps.systemEnvAllowlist !== undefined ? { systemEnvAllowlist: deps.systemEnvAllowlist } : {}),
    ...(deps.childExitGraceMs !== undefined ? { childExitGraceMs: deps.childExitGraceMs } : {}),
    ...(deps.killEscalationMs !== undefined ? { killEscalationMs: deps.killEscalationMs } : {}),
  }
}

/** The optional half of a session's arguments; same forward-only-what-was-given rule. */
export function sessionOptionsOf(deps: ConnectDeps): Partial<StartConnectSessionArgs> {
  return {
    ...(deps.journalDir !== undefined ? { journalDir: deps.journalDir } : {}),
    ...(deps.approvalsBaseDir !== undefined ? { approvalsBaseDir: deps.approvalsBaseDir } : {}),
    ...(deps.inventoryStorePath !== undefined
      ? { inventoryStorePath: deps.inventoryStorePath }
      : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.revocationPollIntervalMs !== undefined
      ? { revocationPollIntervalMs: deps.revocationPollIntervalMs }
      : {}),
    ...(deps.journalCommitBatchImpl !== undefined
      ? { journalCommitBatchImpl: deps.journalCommitBatchImpl }
      : {}),
  }
}

