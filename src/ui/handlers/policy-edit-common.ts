import type { PolicyCreateInfo, PolicyEditInfo, PolicyJournalEdit } from '../../journal/policy-edit-record.js'
import { RESERVED_OBJECT_KEYS } from '../../policy/constants.js'
import type { JournalPolicyEditOutcome } from '../../policy/edit/journal-edit.js'
import type { PolicyFileReadResult, PolicyFileWriteResult, WritePolicyFileOptions } from '../../policy/edit/policy-file.js'
import type { PolicyEditTarget } from '../../policy/edit/write-target.js'
import { SERVER_NAME_PATTERN } from '../../policy/schema.js'
import type { UiSession } from '../auth.js'
import {
  AUDIT_RECORD_DROPPED_WARNING,
  CONTENT_TYPE_HTML,
  CONTENT_TYPE_JSON,
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_INTERNAL_ERROR,
  HTTP_STATUS_OK,
  HTTP_STATUS_SEE_OTHER,
} from '../constants.js'
import { renderNotice } from '../pages/notice.js'
import { headerValue, type UiRequestContext, type UiResult } from '../routes.js'
import type { UiAuditEvent } from './servers.js'

/**
 * What the two `policy.json` edit routes (`servers-tool-rule.ts`,
 * `servers-confirm-rule.ts`) share: the ports bound by the composition root,
 * the refusal shape, the read-for-edit and write-refusal steps, the
 * attribution after a write and the no-JS answer. One copy, so the two routes
 * cannot drift on what a conflict or a dropped journal record says.
 */

/** What the handler learns from the journal port: whether the record landed. */
export type PolicyEditJournalOutcome = Pick<JournalPolicyEditOutcome, 'written'>

/** The ports every policy-edit route needs; the path is bound by the composition root, never by a request. */
export interface PolicyEditPorts {
  /** The file THIS process loaded its policy from. */
  readonly resolveEditTarget: () => Promise<PolicyEditTarget>
  readonly readPolicyFile: (path: string) => Promise<PolicyFileReadResult>
  readonly writePolicyFile: (
    path: string,
    document: unknown,
    options: WritePolicyFileOptions,
  ) => Promise<PolicyFileWriteResult>
  /** The journal sink for the edit record; must not throw (the file is already written) and answers whether the record landed. */
  readonly journal: (edit: PolicyJournalEdit) => Promise<PolicyEditJournalOutcome>
  /** Attribution line sink, as every other UI mutation. */
  readonly audit?: (event: UiAuditEvent) => void
}

export const EXPECTED_HASH_FIELD = 'expected_hash'

export type Refusal = { readonly status: number; readonly payload: Record<string, unknown> }

export function jsonResult(status: number, payload: unknown): UiResult {
  return {
    kind: 'response',
    status,
    headers: { 'content-type': CONTENT_TYPE_JSON },
    body: Buffer.from(JSON.stringify(payload), 'utf8'),
  }
}

export function refusal(status: number, payload: Record<string, unknown>): Refusal {
  return { status, payload }
}

export function isRefusal<T extends object>(value: T | Refusal): value is Refusal {
  return 'payload' in value
}

/** Exactly one decode; a malformed escape is `undefined`, never a throw. */
export function decodeOnce(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

export function isValidServerName(name: string): boolean {
  return SERVER_NAME_PATTERN.test(name) && !RESERVED_OBJECT_KEYS.includes(name)
}

/** JSON callers (the client script posts JSON) get JSON; a native form gets the redirect. */
export function wantsJson(ctx: UiRequestContext): boolean {
  const contentType = headerValue(ctx.headers, 'content-type') ?? ''
  const accept = headerValue(ctx.headers, 'accept') ?? ''
  return contentType.includes('application/json') || accept.includes('application/json')
}

/** The file this process loaded, read for edit; refusable before an edit is even computed. */
export async function loadTarget(
  deps: Pick<PolicyEditPorts, 'resolveEditTarget' | 'readPolicyFile'>,
): Promise<{ readonly path: string; readonly read: Extract<PolicyFileReadResult, { status: 'loaded' }> } | Refusal> {
  const target = await deps.resolveEditTarget()
  const read = await deps.readPolicyFile(target.path)
  if (read.status === 'absent') {
    return refusal(HTTP_STATUS_CONFLICT, { status: 'no-policy', message: 'no policy — enforcement off; nothing to edit' })
  }
  if (read.status === 'error') return invalidPolicyRefusal(target.path, read.errors)
  return { path: target.path, read }
}

/** An unparseable file on disk (O3): never a write target, its errors named. */
export function invalidPolicyRefusal(path: string, errors: readonly string[]): Refusal {
  // The loader's lines never carry the path (0.2.4): name the file once, in front, as the CLI does.
  return refusal(HTTP_STATUS_CONFLICT, {
    status: 'invalid-policy',
    message: 'the policy file on disk is invalid; fix it by hand before editing here',
    errors: errors.map((line) => `${path}: ${line}`),
  })
}

export function writeRefusal(written: Exclude<PolicyFileWriteResult, { status: 'written' }>): Refusal {
  if (written.status === 'conflict') {
    return refusal(HTTP_STATUS_CONFLICT, { status: 'conflict', message: 'policy changed on disk — reload the page and retry' })
  }
  return refusal(HTTP_STATUS_INTERNAL_ERROR, { status: 'error', message: 'the policy file could not be written', errors: written.errors })
}

/**
 * After the file is on disk: the attribution line, then the journal record —
 * each exactly once — and whether the record landed. The port never throws by
 * contract; the guard keeps that true for ANY injected port, because a throw
 * here would turn a rule that is already live into a 500 with no record.
 */
export async function recordPolicyEdit(
  deps: Pick<PolicyEditPorts, 'journal' | 'audit'>,
  session: UiSession,
  audit: { readonly action: string; readonly target: string },
  edit: Omit<PolicyEditInfo, 'actor'> | Omit<PolicyCreateInfo, 'actor'>,
): Promise<PolicyEditJournalOutcome> {
  deps.audit?.({ actor: 'ui', adminName: session.adminName, action: audit.action, target: audit.target })
  try {
    const outcome = await deps.journal({ actor: { adminName: session.adminName, role: session.role, via: 'ui' }, ...edit })
    return { written: outcome.written }
  } catch {
    return { written: false }
  }
}

/**
 * The no-JS answer: the 303 back to `/servers` when the audit record landed,
 * a success notice carrying the F1 warning when it was dropped — a redirect
 * has nowhere to say it. Still a 200: the file is on disk and the rule is live.
 */
export function formAnswer(session: UiSession, message: string, journal: PolicyEditJournalOutcome): UiResult {
  if (journal.written) {
    return { kind: 'response', status: HTTP_STATUS_SEE_OTHER, headers: { location: '/servers' } }
  }
  const body = renderNotice({
    title: 'Servers',
    message,
    ok: true,
    backHref: '/servers',
    backLabel: 'Back to servers',
    session,
    warning: AUDIT_RECORD_DROPPED_WARNING,
  })
  return { kind: 'response', status: HTTP_STATUS_OK, headers: { 'content-type': CONTENT_TYPE_HTML }, body }
}
