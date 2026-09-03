import type { AccessEditInfo } from '../journal/access-edit-record.js'
import type { AdminRefusalWording, RequiredAdmin } from './admin-token.js'
import {
  recordAccessChange,
  requireAccessOwner,
  type AccessOp,
  type AccessWriteOptions,
} from './access-cmd-write.js'
import type { VaultCliIo, VaultCmdDeps } from './vault-cmd.js'

/**
 * The `vault` half of the shared access write path (`access-cmd-write.ts`):
 * the owner gate in front of `vault set|remove|rekey` and the two records
 * behind each — the stderr audit line and the `access-edit` journal record.
 *
 * Owner decision S2 (2026-09-03, security audit U2): replacing a secret
 * replaces the identity a server uses against an external system. A journal
 * that shows the agent's call but not who swapped the token an hour earlier
 * has a hole in attribution — so the vault joins `agent *` and `group *`
 * behind the SAME gate and the SAME record, with the secret's NAME as the
 * only thing named, never its value (ADR-0003, amendment 2026-09-03). `vault
 * init` (bootstrap, before any admin exists) and `vault list` stay token-free.
 *
 * The token buys ATTRIBUTION, not protection: a process under the same uid
 * reads `vault.key` next to `vault.enc` either way (ADR-0003 threat model,
 * unchanged).
 *
 * Only types are imported back from `vault-cmd.ts`, so the two modules share
 * no runtime edge.
 */

/** How the shared token gate names this command's refusals. */
const VAULT_REFUSAL: AdminRefusalWording = {
  action: 'change the vault',
  noun: 'change',
  verb: 'may not change vault secrets',
  roleDetail: 'the same rule agent and group mutations apply',
}

/**
 * The vault command's deps in the shared write path's terms. ONE clock seam:
 * the `now` that stamps a secret's `updatedAt` also stamps its journal record,
 * so a test (or an auditor) never sees the two disagree.
 */
export function accessWriteOptionsOf(deps: VaultCmdDeps): AccessWriteOptions {
  const now = deps.now
  return {
    ...(deps.journalDir !== undefined ? { journalDir: deps.journalDir } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(now !== undefined ? { clock: () => new Date(now()) } : {}),
    ...(deps.deps !== undefined ? { deps: deps.deps } : {}),
  }
}

/** The owner behind `MCP_ADMIN_TOKEN`, or `undefined` with the refusal already printed. */
export async function requireOwner(
  io: VaultCliIo,
  deps: VaultCmdDeps,
): Promise<RequiredAdmin | undefined> {
  return requireAccessOwner(io, accessWriteOptionsOf(deps), VAULT_REFUSAL)
}

/**
 * The audit line plus the journal record of one applied vault change. The
 * `info` names the secret at most; the value went into the vault and has no
 * field here to ride in on (pinned by `tests/cli/vault-cmd-token.test.ts`).
 */
export async function recordChange(
  io: VaultCliIo,
  deps: VaultCmdDeps,
  actor: RequiredAdmin,
  op: AccessOp,
  target: string,
  info: Omit<AccessEditInfo, 'actor'>,
): Promise<number> {
  return recordAccessChange({
    io,
    opts: accessWriteOptionsOf(deps),
    actor,
    subject: 'vault',
    op,
    target,
    info,
  })
}
