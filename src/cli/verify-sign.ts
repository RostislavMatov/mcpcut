import { latestAttestedChainHead, type ChainVerifyResult } from '../journal/chain-verify.js'
import {
  CHAIN_HEAD_ANCHOR_FORMAT_VERSION,
  loadSigningPrivateKey,
  signChainHeadAnchor,
  type SignedChainHeadAnchor,
  type UnsignedChainHeadAnchor,
} from '../journal/signing.js'
import type { SqliteHandle } from '../store/sqlite.js'

/**
 * `verify --sign`'s own half of the M5 wave 4 signing feature (task 4.3):
 * decides whether there is a HEAD worth signing at all, and formats the
 * result. Split out of `verify-cmd.ts` to keep that file under this
 * project's 400-line cap; the crypto itself lives in `journal/signing.ts`,
 * which this module is the only CLI-facing caller of.
 *
 * Signs the chain's HEAD, never a per-record signature (plan design
 * decision -- the chain already binds every record to the one before it, so
 * signing the head attests the whole prefix a `verify` walk just checked).
 */

/** One outcome of a `--sign` attempt: what to print, where, and whether it counts as a hard failure. */
export interface SignAttemptOutcome {
  /** `false` means "could not sign as asked" -- the caller should treat this as an exit-1 failure, independent of the chain's own break status. */
  readonly ok: boolean
  readonly message: string
}

/**
 * Attempts to sign the current chain head. Two honest refusals, named
 * exactly as the plan calls out as traps:
 * - no signing key exists at all (`journal/signing.ts`'s discriminated
 *   `SigningPrivateKeyLookup` -- this function pattern-matches it rather
 *   than assuming presence, so there is no code path that reaches signing
 *   logic without a real key);
 * - no chain head exists to sign (`latestAttestedChainHead` returns `null`
 *   for both an empty journal and a journal that predates the chain
 *   entirely -- signing either would misrepresent "nothing attested yet" as
 *   an attested statement).
 */
export async function attemptSignChainHead(
  handle: SqliteHandle,
  journalDir: string,
  result: ChainVerifyResult,
): Promise<SignAttemptOutcome> {
  const keyLookup = await loadSigningPrivateKey(journalDir)
  if (!keyLookup.present) {
    return {
      ok: false,
      message:
        'No signing key present; the report will be unsigned. ' +
        'Generate one first with: mcp-journal keygen\n',
    }
  }

  const head = latestAttestedChainHead(handle)
  if (head === null) {
    return {
      ok: false,
      message:
        `Nothing to sign: ${
          result.totalRowCount === 0
            ? 'the journal is empty.'
            : 'every record predates the hash chain (no attested head exists yet).'
        }\n`,
    }
  }

  const anchor: UnsignedChainHeadAnchor = {
    formatVersion: CHAIN_HEAD_ANCHOR_FORMAT_VERSION,
    seq: head.seq,
    recordHash: head.recordHash,
    signedAt: new Date().toISOString(),
  }
  const signed = signChainHeadAnchor(keyLookup.privateKeyPem, anchor)
  return { ok: true, message: anchorLines(signed, result) }
}

/**
 * The signed anchor plus the honest limitation of what it buys, printed in
 * the command's OWN output (not left to docs) per the task brief. When the
 * walk already found a break, an extra note keeps the anchor from reading
 * as a clean bill of health for the whole chain -- it only attests to the
 * CURRENT head, whatever led up to it.
 */
function anchorLines(signed: SignedChainHeadAnchor, result: ChainVerifyResult): string {
  const lines: string[] = [
    '\nChain head anchor:\n',
    `  formatVersion:  ${signed.anchor.formatVersion}\n`,
    `  seq:            ${signed.anchor.seq}\n`,
    `  recordHash:     ${signed.anchor.recordHash}\n`,
    `  signedAt:       ${signed.anchor.signedAt}\n`,
    `  keyFingerprint: ${signed.anchor.keyFingerprint}\n`,
    `  signature (ed25519, base64): ${signed.signatureBase64}\n`,
  ]

  if (result.break !== null) {
    lines.push(
      '\nNOTE: a break was found above (see "BROKEN at seq ..."). This anchor attests only to the ' +
        'CURRENT head as stored right now -- it does not certify that the prefix leading to it is intact.\n',
    )
  }

  lines.push(
    '\nRecord this anchor OUTSIDE this host (write it down, paste it into a ticket, print it) -- that ' +
      'copy is the ONLY thing that makes tampering detectable later. A process running as the same user ' +
      'that wrote this database can rewrite the chain end to end and re-sign it with this very key; the ' +
      'signature alone proves nothing without an anchor kept somewhere this host cannot also rewrite.\n',
  )

  return lines.join('')
}
