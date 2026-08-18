import { canonicalJson, sha256Hex } from './hash.js'
import type { Policy } from './schema.js'

/**
 * Provenance fingerprints for decision records (M5): "which rules was this
 * call decided under". Kept apart from `hash.ts`, whose canonicalization
 * mechanism this reuses but whose scope is tool-schema fingerprints
 * (rug-pull detection) rather than the rules themselves.
 *
 * Both hashes are recorded *on the decision record*, before anything signs
 * it, so the later hash chain covers them: an operator who loosens a policy
 * or widens an agent's grants cannot make an already-written record claim it
 * ran under the new rules.
 */

/**
 * Fingerprint of the policy a decision was made under.
 *
 * The *effective* policy is hashed -- the parsed object with the schema's
 * defaults already applied -- deliberately, not the raw bytes of
 * `policy.json`. Two reasons:
 *
 *  - An auditor must be able to reproduce the fingerprint of the rules that
 *    actually ran. A raw-bytes hash fingerprints a *file*, and a file says
 *    nothing about what the unspecified settings resolved to; the effective
 *    object is the complete ruleset the gate consulted.
 *  - Two different files that resolve to the same effective policy
 *    legitimately hash the same. Reformatting the JSON, reordering keys, or
 *    spelling a default out explicitly changes the file but changes no rule,
 *    and a fingerprint that moved on any of those would cry wolf often
 *    enough to be ignored -- exactly what an integrity signal must not do.
 *
 * Conversely, any genuine change to a rule (a `defaultDecision`, one
 * per-server pattern, a quarantine toggle) changes the hash, because
 * `canonicalJson` covers the whole object.
 */
export function policyHashOf(policy: Policy): string {
  return sha256Hex(canonicalJson(policy))
}

/**
 * What a grant matrix looks like from here: server name -> that server's
 * grant OBJECT. Structural on purpose, so the policy layer stays independent
 * of the agents module, but deliberately narrower than
 * `Record<string, unknown>` — see `grantsHashOf`.
 */
export type GrantMatrix = Readonly<Record<string, Readonly<Record<string, unknown>>>>

/**
 * Fingerprint of an agent's grant matrix as of the moment a record is
 * written. The input is the matrix ITSELF — `AgentRecord.grants` — and
 * nothing wider.
 *
 * Not `unknown`, and not `Record<string, unknown>` either: a caller that
 * handed over the whole `AgentRecord` would fold `tokenHash` into the
 * fingerprint, which would then move on token ROTATION. A published digest
 * that moves when a credential is rotated is a rotation oracle, and it stops
 * meaning "these are the rules" altogether (SEC-L1). `Record<string,
 * unknown>` does not actually stop that — `AgentRecord` is a zod-INFERRED
 * type alias, so it gets an implicit index signature and satisfies it. What
 * does stop it is typing the VALUES: a matrix maps names to grant objects,
 * and `AgentRecord.tokenHash` is a string, so the record no longer fits while
 * `record.grants` still does.
 *
 * Two differences are deliberately invisible here, for the same reason
 * `policyHashOf` ignores file formatting:
 *
 *  - Object key order (`canonicalJson` sorts it).
 *  - The ORDER of the pattern lists inside one server's grant.
 *    `agent grant a1 github --tool read_* --tool write_file` and the same two
 *    flags reversed authorize identically — `grantServer` stores the CLI
 *    array verbatim and `scope.ts` builds a lookup from it, so position
 *    carries no meaning. A fingerprint that moved on the reorder would show
 *    an auditor an authorization change where none occurred: crying wolf,
 *    which is what an integrity signal must never do.
 *
 * Everything else still moves the hash, including a repeated pattern: this
 * normalizes order, it does not deduplicate, so two matrices that genuinely
 * differ keep differing.
 */
export function grantsHashOf(grants: GrantMatrix): string {
  return sha256Hex(canonicalJson(normalizeMatrix(grants)))
}

/** Server name -> normalized grant. Never mutates the input. */
function normalizeMatrix(grants: GrantMatrix): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(grants).map(([serverName, grant]) => [serverName, normalizeGrant(grant)]),
  )
}

/**
 * Sorts every string-array field of one server's grant (`tools`, `resources`,
 * `prompts` today; anything array-shaped added later, by construction). A
 * `'*'` grant is a literal, not a one-element list, and passes through
 * untouched — "every tool" must stay distinguishable from "the tool named
 * `*`". A non-object entry (a hand-edited or foreign store) is returned as
 * is: validating the matrix is not this function's job, but it must still
 * produce a fingerprint rather than throw.
 */
function normalizeGrant(grant: unknown): unknown {
  if (typeof grant !== 'object' || grant === null || Array.isArray(grant)) return grant
  return Object.fromEntries(
    Object.entries(grant as Record<string, unknown>).map(([field, value]) => [
      field,
      Array.isArray(value) ? sortedCopy(value) : value,
    ]),
  )
}

/**
 * A sorted COPY: the caller's live grant matrix is never reordered in place.
 *
 * Ordered by UTF-16 code unit, NOT by `localeCompare`: the digest has to be
 * reproducible by a different process on a different machine, and locale
 * collation varies with the ICU data a runtime was built against. Sorting is
 * stable, so equal entries keep their relative order.
 */
function sortedCopy(items: readonly unknown[]): unknown[] {
  return [...items].sort((left, right) => compareAsText(String(left), String(right)))
}

function compareAsText(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}
