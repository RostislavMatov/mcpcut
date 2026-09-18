import { sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { canonicalJson } from '../policy/hash.js'
import type { ReportManifest } from './report.js'
import { privateKeyAlgorithm, privateKeyFingerprint } from './signing.js'

/**
 * Signs and verifies the audit report's manifest (M5 wave 5, task 5.1).
 *
 * WHY A SECOND FILE RATHER THAN MORE OF `signing.ts`. This is the manifest
 * half of the same signing surface and belongs conceptually beside
 * `signChainHeadAnchor`; it lives here only because `signing.ts` is already
 * at the project's hard 400-line cap and this module's own docs would push
 * it over. It is therefore registered as a SECOND allowed signing adapter in
 * `tests/architecture/imports.test.ts` -- the boundary the architecture test
 * enforces is "asymmetric crypto appears in a named, enumerated set of
 * files", and that set now has two members, both named there explicitly.
 * Nothing else may import a signing primitive. Key DERIVATION is not
 * duplicated: `privateKeyFingerprint` is imported from `signing.ts` so both
 * signers answer "which key signed this" through the same code.
 *
 * WHAT IS SIGNED. `canonicalJson(manifest)` (`policy/hash.ts`), UTF-8 --
 * the whole manifest, including `records.sha256` and the `contract` text.
 * Signing the manifest rather than the record bytes is what keeps this cheap
 * on a gigabyte export: the manifest transitively commits to
 * `records.jsonl` through its digest, so one signature covers everything.
 * `canonicalJson` is the right serializer here for the same reason it is
 * right for the chain-head anchor and wrong for a `doc`: the manifest is a
 * control-plane-owned object whose FIELD VALUES an auditor is handed, so a
 * third party reproduces these exact bytes by re-serializing those values
 * the documented way -- there are no stored bytes to reproduce verbatim.
 * (`records.jsonl` itself is covered byte-for-byte, via its sha256.)
 *
 * THE SAME HONEST THREAT MODEL applies as in `signing.ts`: this proves the
 * report came from the holder of this installation's private key. It does
 * not prove the host was not tampered with -- a process under the same uid
 * can rewrite the journal, re-export and re-sign. Only an out-of-band anchor
 * makes that detectable, which is why `AS_OF_CONTRACT` says so inside the
 * signed bytes themselves.
 */

/**
 * Version of `signature.json`'s own shape. Separate from the report's
 * `formatVersion` (a signature file could gain a field without the manifest
 * changing, and vice versa), but expected to move in step with it; either
 * bump is breaking for anything that recomputes the signed bytes.
 */
export const REPORT_SIGNATURE_FORMAT_VERSION = 1

/**
 * The algorithm identifier written into `signature.json`. Ed25519 by owner
 * decision O2 -- see `signing.ts`.
 *
 * It is DERIVED from the signing key and compared with this constant, never
 * simply stamped (wave-5 review, MEDIUM): the review signed a manifest with
 * an RSA key and got a signature file asserting `ed25519`, and an auditor
 * verifying independently follows the STATED algorithm. A signature file that
 * misnames its own algorithm is worse than an unsigned export, because it
 * produces a confident wrong answer instead of an honest "unsigned".
 */
export const REPORT_SIGNATURE_ALGORITHM = 'ed25519'

/** `signature.json`, written only when a signing key exists. Its absence means UNSIGNED, never "verified". */
export interface ReportSignatureFile {
  readonly formatVersion: number
  readonly algorithm: typeof REPORT_SIGNATURE_ALGORITHM
  /** Fingerprint of the key that ACTUALLY signed; also copied onto the manifest. */
  readonly keyFingerprint: string
  readonly signatureBase64: string
}

export interface SignedReportManifest {
  /** The manifest as signed -- i.e. with `keyFingerprint` stamped on. This, not the caller's input, is what must be written to `report.json`. */
  readonly manifest: ReportManifest
  /** The exact bytes signed, for a caller that wants to echo them verbatim. */
  readonly canonicalBytes: string
  readonly signature: ReportSignatureFile
}

/**
 * Signs `manifest` with the installation's Ed25519 private key.
 *
 * `keyFingerprint` is DERIVED from `privateKeyPem` and overwrites whatever
 * the caller's manifest carried, exactly as `signChainHeadAnchor` does and
 * for the same reason: a fingerprint the caller supplied would be a claim
 * about which key signed, sitting inside the very bytes that claim is
 * supposed to be verifiable from. Deriving it means the field can only ever
 * name the key that actually produced the signature beside it.
 *
 * The returned `manifest` is a new object -- the caller's is never mutated --
 * and it is the one that must be serialized to `report.json`: writing the
 * pre-signing manifest instead would ship bytes the signature does not
 * cover.
 *
 * Ed25519 signs the message directly (no separate digest algorithm), hence
 * the `null` first argument to `crypto.sign` -- the documented Node API
 * shape for this algorithm.
 */
export function signReportManifest(
  privateKeyPem: string,
  manifest: ReportManifest,
): SignedReportManifest {
  const algorithm = privateKeyAlgorithm(privateKeyPem)
  if (algorithm !== REPORT_SIGNATURE_ALGORITHM) {
    // Refuse rather than label: `signature.json`'s `algorithm` field is what
    // an independent verifier follows, and this format has exactly one
    // algorithm (owner decision O2). A key of another type is an operator
    // mistake to fix, not something to silently mislabel.
    throw new TypeError(
      `Refusing to sign the report manifest: the signing key is ${algorithm}, but this report ` +
        `format signs with ${REPORT_SIGNATURE_ALGORITHM} only. Generate an installation key ` +
        'with: mcpcut keygen',
    )
  }
  const keyFingerprint = privateKeyFingerprint(privateKeyPem)
  const signedManifest: ReportManifest = { ...manifest, keyFingerprint }
  const canonicalBytes = canonicalJson(signedManifest)
  const signatureBase64 = cryptoSign(
    null,
    Buffer.from(canonicalBytes, 'utf8'),
    privateKeyPem,
  ).toString('base64')
  return {
    manifest: signedManifest,
    canonicalBytes,
    signature: {
      formatVersion: REPORT_SIGNATURE_FORMAT_VERSION,
      // The derived value, checked against the constant above -- so this
      // field can only ever name the algorithm that actually signed.
      algorithm,
      keyFingerprint,
      signatureBase64,
    },
  }
}

/**
 * Verifies a manifest's signature against a public key. Recomputes the
 * canonical bytes from the manifest's OWN fields rather than trusting any
 * copy of them handed over alongside -- the same rule
 * `verifyChainHeadAnchorSignature` follows, and the only version of this
 * check that actually answers "did these field values produce this
 * signature".
 *
 * Never throws: malformed base64, a malformed or foreign PEM, and a
 * wrong-algorithm key all collapse to `false`, so a caller has exactly one
 * failure mode to handle. An export directory is untrusted input, and
 * `verify --report` must report a bad signature as a FAILED check, not as a
 * crash that leaves the other checks unreported.
 */
export function verifyReportManifestSignature(
  publicKeyPem: string,
  manifest: ReportManifest,
  signatureBase64: string,
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalJson(manifest), 'utf8'),
      publicKeyPem,
      Buffer.from(signatureBase64, 'base64'),
    )
  } catch {
    return false
  }
}
