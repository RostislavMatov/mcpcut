import { CREATED_POLICY_DOCUMENT } from '../../policy/edit/created-policy.js'
import { TENANT_SETTINGS, type TenantSettings } from '../../tenant/settings.js'
import type { UiSession } from '../auth.js'
import { roleSatisfies } from '../authz.js'
import {
  AUDIT_RECORD_DROPPED_WARNING,
  CONTENT_TYPE_HTML,
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_OK,
} from '../constants.js'
import { renderNotice } from '../pages/notice.js'
import type { UiHandler, UiRequestContext, UiResult } from '../routes.js'
import {
  invalidPolicyRefusal,
  jsonResult,
  recordPolicyEdit,
  refusal,
  wantsJson,
  writeRefusal,
  type PolicyEditPorts,
  type Refusal,
} from './policy-edit-common.js'

/**
 * `POST /servers/create-policy` (ADR-0009, amendment 2026-10-02) — the
 * explicit action O4 asked for: "no policy" becomes a file only when an owner
 * presses this, never as a side effect of a rule click. Its answers to the
 * ADR's two questions:
 *
 *  - **defaults**: `CREATED_POLICY_DOCUMENT` — every call allowed, quarantine
 *    off, the outcomes of running with no file — so the click changes no call
 *    by itself; it turns on the per-tool buttons and the owner chooses there;
 *  - **what the owner sees first**: the page shows that document and the path
 *    beside the button (`pages/servers-policy-create.ts`).
 *
 * The rest is the sibling routes' threat model (`servers-tool-rule.ts`): the
 * path is the one this process resolved (`resolveEditTarget`), nothing in the
 * request names a file; the write is compare-and-swap on `null`, so an
 * existing file — however it got there — is never overwritten; a success is
 * journaled (`policy-edit`, `created: true`) and audited exactly once.
 *
 * The form posts natively and the answer is a page, not a redirect: the next
 * step — restart the client once, so servers started without a policy read
 * it — has to be said, and a redirect has nowhere to say it. A hosted
 * (tenant) install is refused: its page offers no button either.
 */

export interface ServersCreatePolicyDeps extends PolicyEditPorts {
  /** Defaults to `TENANT_SETTINGS`, as the Servers page handler does. */
  readonly tenant?: TenantSettings
}

export interface ServersCreatePolicyHandlers {
  readonly serversCreatePolicy: UiHandler
}

const AUDIT_ACTION = 'policy.create'
const SERVERS_HREF = '/servers'
const NEXT_LABEL = 'Choose tools on Servers'
const BACK_LABEL = 'Back to servers'

function createdMessage(path: string): string {
  return (
    `Created ${path}. Every call is still allowed — nothing asks you until you choose tools. ` +
    'Next: restart your client once (quit and reopen Claude Code or Cursor) so the servers behind mcpcut read it, ' +
    'then choose tools on Servers.'
  )
}

function existsRefusal(path: string): Refusal {
  return refusal(HTTP_STATUS_CONFLICT, {
    status: 'exists',
    message:
      `A policy already exists at ${path} — nothing was changed. ` +
      'If you just created it, restart your client once, then choose tools on Servers.',
  })
}

function htmlResult(status: number, body: string): UiResult {
  return { kind: 'response', status, headers: { 'content-type': CONTENT_TYPE_HTML }, body: Buffer.from(body, 'utf8') }
}

/** A JSON caller gets the refusal as is; the native form gets a page that says it and links back. */
function refuse(ctx: UiRequestContext, session: UiSession, refused: Refusal): UiResult {
  if (wantsJson(ctx)) return jsonResult(refused.status, refused.payload)
  const errors = Array.isArray(refused.payload.errors) ? refused.payload.errors.map(String) : []
  const message = [String(refused.payload.message ?? ''), ...errors].join(' ')
  const backLabel = refused.payload.status === 'exists' ? NEXT_LABEL : BACK_LABEL
  return htmlResult(
    refused.status,
    renderNotice({ title: 'Servers — error', message, ok: false, backHref: SERVERS_HREF, backLabel, session }),
  )
}

export function createServersCreatePolicyHandlers(deps: ServersCreatePolicyDeps): ServersCreatePolicyHandlers {
  /** The path to create, or why not: only an absent file is a target. */
  async function targetPath(): Promise<string | Refusal> {
    const target = await deps.resolveEditTarget()
    const read = await deps.readPolicyFile(target.path)
    if (read.status === 'loaded') return existsRefusal(target.path)
    if (read.status === 'error') return invalidPolicyRefusal(target.path, read.errors)
    return target.path
  }

  async function serversCreatePolicy(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined || !roleSatisfies(session.role, 'owner')) {
      return jsonResult(HTTP_STATUS_FORBIDDEN, { status: 'forbidden', message: 'Owner role required.' })
    }
    if ((deps.tenant ?? TENANT_SETTINGS).isTenant) {
      return jsonResult(HTTP_STATUS_FORBIDDEN, { status: 'forbidden', message: 'not available on a hosted install' })
    }

    const path = await targetPath()
    if (typeof path !== 'string') return refuse(ctx, session, path)

    const written = await deps.writePolicyFile(path, CREATED_POLICY_DOCUMENT, { expectedHash: null })
    if (written.status === 'conflict') return refuse(ctx, session, existsRefusal(path))
    if (written.status !== 'written') return refuse(ctx, session, writeRefusal(written))

    // The file is on disk: attribute FIRST, exactly once.
    const journal = await recordPolicyEdit(
      deps,
      session,
      { action: AUDIT_ACTION, target: path },
      { created: true, policyHashBefore: null, policyHashAfter: written.hashAfter, sourcePath: path },
    )
    if (wantsJson(ctx)) {
      const journalState: 'written' | 'dropped' = journal.written ? 'written' : 'dropped'
      return jsonResult(HTTP_STATUS_OK, { status: 'ok', path, hashAfter: written.hashAfter, journal: journalState })
    }
    return htmlResult(
      HTTP_STATUS_OK,
      renderNotice({
        title: 'Servers',
        message: createdMessage(path),
        ok: true,
        backHref: SERVERS_HREF,
        backLabel: NEXT_LABEL,
        session,
        ...(journal.written ? {} : { warning: AUDIT_RECORD_DROPPED_WARNING }),
      }),
    )
  }

  return { serversCreatePolicy }
}
