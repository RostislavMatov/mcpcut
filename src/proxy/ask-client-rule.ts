import { isApprovableInClient } from '../policy/approve-in-client.js'
import type { ApprovalQueue } from '../policy/approvals/queue.js'
import { toPolicyProvider, type PolicyProvider } from '../policy/reload.js'
import type { Policy } from '../policy/schema.js'
import type { ApprovalQuestion, AskClientOptions } from './client-approval.js'
import type { MessagePolicyGateDeps } from './gate-types.js'

/**
 * Who may be asked to approve a held call in the client (ADR-0019), in one
 * place for `wrap` (`wire-policy.ts`) and an agent's `connect`
 * (`cli/connect-session.ts`):
 *
 *  - `approval.askClient: false` — nobody, whatever else is set;
 *  - a tool listed in `servers.<name>.approveInClient` — the person at the
 *    client, on any path and with admins on the installation: the admin named
 *    the tool;
 *  - any other held tool — only where the entry point allows it
 *    (`mayAskUnlisted`: `wrap` while the installation has no admins).
 *
 * Read per question from the live policy, so an edit applies without a
 * restart; and again when the answer lands, so a rule or an admin that
 * changed in between makes the answer count for nothing.
 */

export interface AskClientWiring extends AskClientOptions {
  /** Lines for the operator's terminal or the session's diagnostics. */
  readonly onNotice?: (text: string) => void
}

export interface AskClientTarget {
  readonly policy: Policy | PolicyProvider
  readonly serverName: string
}

export function askClientDepsOf(
  target: AskClientTarget,
  wiring: AskClientWiring | undefined,
  queue: Pick<ApprovalQueue, 'resolve'>,
): Pick<MessagePolicyGateDeps, 'askClient'> {
  if (wiring === undefined) return {}
  const provider = toPolicyProvider(target.policy)
  const notice = wiring.onNotice ?? ((): void => undefined)

  async function mayAsk(question: ApprovalQuestion): Promise<boolean> {
    const policy = provider.current()
    if (policy.approval.askClient === false) return false
    if (isApprovableInClient(policy, target.serverName, question.toolName)) return true
    return wiring?.mayAskUnlisted !== undefined && (await wiring.mayAskUnlisted())
  }

  return {
    askClient: {
      mayAsk,
      command: wiring.command,
      ...(wiring.onNotice !== undefined ? { onNotice: wiring.onNotice } : {}),
      resolve: async (question, resolution) => {
        // A check that fails counts as "no": the answer is dropped, never applied unchecked.
        if (!(await mayAsk(question).catch(() => false))) {
          notice(
            `An answer in the client cannot settle ${question.approvalId}: the policy or the installation no longer lets it.\n` +
              `  Approve with your token: ${wiring.command} approvals approve ${question.approvalId}\n`,
          )
          return undefined
        }
        return queue.resolve(question.approvalId, resolution)
      },
    },
  }
}
