import type { TenantSettings } from '../tenant/settings.js'
import { createRequestBudget, type RequestBudget } from '../transport/http/request-budget.js'

/**
 * Whether `serve`'s agent front has a request budget, and how big (plan
 * `hosted-path-and-ops`, P7). The decision lives here, in the command's
 * wiring, because only the wiring may read tenant mode: the transport is
 * handed a ready budget (or none) and never learns why (ADR-0001 layering —
 * `src/transport/**` imports nothing from `src/tenant`).
 *
 * Not a tenant install → `undefined`, and the front runs exactly as before.
 * A tenant install → a fresh budget per call, so two fronts (two tests, or a
 * restart) never share one; the counters live in that front's memory and a
 * restart starts them afresh (P7, accepted).
 */
export function requestBudgetFor(settings: TenantSettings): RequestBudget | undefined {
  if (!settings.isTenant) {
    return undefined
  }
  return createRequestBudget({
    perSecond: settings.limits.requestsPerSecond,
    perDay: settings.limits.requestsPerDay,
  })
}
