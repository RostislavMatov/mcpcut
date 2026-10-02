/**
 * What "Create policy" on the Servers page writes (ADR-0009, amendment
 * 2026-10-02): every call allowed, quarantine off. Those are the outcomes of
 * running with no policy file at all, so creating it changes no call by
 * itself — it only turns on the per-tool buttons, and the operator chooses
 * from there. The README's confirm-in-the-client example starts from the same
 * three keys. Frozen: one shared value, written as is.
 */
export const CREATED_POLICY_DOCUMENT = Object.freeze({
  version: 1,
  defaultDecision: 'allow',
  quarantine: Object.freeze({ enabled: false }),
})
