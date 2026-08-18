import type { ReportManifest } from './report.js'
import { verifyReportManifestSignature, type ReportSignatureFile } from './report-signing.js'
import type { ReportSignaturePresence, Verdict, VerifyingKey } from './report-verify.js'
import { publicKeyFingerprint } from './signing.js'

/**
 * Everything about the key and the signature file (M5 wave 5, task 5.3;
 * hardened in the wave-5 review round). Split out of `report-verify.ts` when
 * the review pushed that module past the project's 400-line cap.
 *
 * Three defects shaped what is here:
 *
 * - V6/A3: a manifest that NAMES a key while `signature.json` is absent used
 *   to print as a clean UNSIGNED PASS, because the absent-signature branch
 *   returned before anything consulted `manifest.keyFingerprint`. That state
 *   means a signature was removed -- or an export died between the two
 *   writes -- and it is a FAILURE, not a normal unsigned export.
 * - V5/A5: a malformed `signature.json` must make THIS check could-not-run
 *   and nothing else; it must never suppress the byte checks (that is the
 *   orchestrator's job, but the `unreadable` state is modelled here).
 * - V8: `createPublicKey` happily derives a public key from a PRIVATE PEM,
 *   so `--pub ~/.mcp-journal/signing.key` printed PASS. The documented next
 *   step in the workflow is "hand the auditor the public key", and an
 *   operator who discovers that `signing.key` "works" has a plausible route
 *   to shipping the installation's private key.
 */

/** A public key an auditor was handed, with the fingerprint DERIVED from it -- never a fingerprint taken on anyone's word. */
export type VerifyingKeyLookup =
  | { readonly ok: true; readonly key: VerifyingKey }
  | { readonly ok: false; readonly message: string }

/**
 * PEM labels that mean "this is a private key". Matched on the ARMOR TEXT,
 * before any crypto call: `createPublicKey` accepts a private PEM and
 * silently derives the public half, so asking the crypto layer "is this
 * public?" cannot answer the question. Covers the encodings OpenSSL and Node
 * emit (`openssl genpkey`, `openssl rsa`, `ssh-keygen -m PEM`), because an
 * operator reaching for the wrong file will have produced it with one of
 * them.
 */
const PRIVATE_PEM_MARKERS: readonly string[] = [
  'BEGIN PRIVATE KEY',
  'BEGIN ENCRYPTED PRIVATE KEY',
  'BEGIN RSA PRIVATE KEY',
  'BEGIN EC PRIVATE KEY',
  'BEGIN DSA PRIVATE KEY',
  'BEGIN OPENSSH PRIVATE KEY',
]

/**
 * Loads a public key an auditor supplied. Separate from `verifyReportExport`
 * so "this file is not a usable public key" is a could-not-run the CLI exits
 * 1 on, never a FAILED signature check: an auditor who typo'd a path has
 * learned nothing about the report and must not be told the signature is
 * bad. Never throws -- an untrusted PEM is exactly where `createPublicKey`
 * does.
 */
export function readVerifyingKey(pem: string): VerifyingKeyLookup {
  const privateMarker = PRIVATE_PEM_MARKERS.find((marker) => pem.includes(marker))
  if (privateMarker !== undefined) {
    return {
      ok: false,
      message:
        `a PRIVATE key ("${privateMarker}"), not a public one. Verification needs only the PUBLIC half ` +
        '(signing.pub); the private key must never leave the host that wrote the journal, and handing ' +
        'it to anyone -- including an auditor -- lets them re-sign a rewritten journal. Refused on ' +
        'purpose, even though a public key can be derived from it',
    }
  }
  try {
    return { ok: true, key: { pem, fingerprint: publicKeyFingerprint(pem) } }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `not a readable public key PEM (${detail})` }
  }
}

const UNSIGNED_DETAIL =
  'UNSIGNED -- this export carries no signature.json, so nothing here ties it to any installation key. ' +
  'The byte checks still show the directory is internally consistent, but anyone could have produced ' +
  'it. Ask the operator for a signed export and the matching public key.'

export interface SignatureCheckInput {
  readonly manifest: ReportManifest
  readonly signature: ReportSignaturePresence
  readonly key: VerifyingKey | null
  /** `--require-signature`: an export that is not provably attributable becomes a FAILED check (amendment A4). */
  readonly requireSignature: boolean
}

export function signatureVerdict(input: SignatureCheckInput): Verdict {
  return escalateIfRequired(baseSignatureVerdict(input), input.requireSignature)
}

function baseSignatureVerdict({ manifest, signature, key }: SignatureCheckInput): Verdict {
  if (signature.status === 'unreadable') {
    return {
      status: 'could-not-run',
      detail:
        `signature.json is present but could not be read (${signature.reason}). Every other check above ` +
        'still ran: an unreadable signature says nothing about the record bytes.',
    }
  }
  if (signature.status === 'absent') return absentSignatureVerdict(manifest)
  if (key === null) {
    return {
      status: 'could-not-run',
      detail:
        'signature.json is present but no public key was available to check it against. Point --pub at ' +
        'the public key the operator handed over (signing.pub).',
    }
  }
  return presentSignatureVerdict(manifest, signature.signature, key)
}

/**
 * Amendment A3. An unsigned export is a legitimate state; an unsigned export
 * whose manifest still NAMES the key that signed it is not -- the signature
 * was removed, or the export died between writing `report.json` and
 * `signature.json`. Both reviewers hit this independently, and it printed as
 * a clean UNSIGNED PASS.
 */
function absentSignatureVerdict(manifest: ReportManifest): Verdict {
  if (manifest.keyFingerprint === undefined) return { status: 'not-applicable', detail: UNSIGNED_DETAIL }
  return {
    status: 'failed',
    detail:
      `the manifest says it was signed by the key with fingerprint ${manifest.keyFingerprint}, but there ` +
      'is no signature.json in this directory. A signature was removed from this export, or the export ' +
      'failed between writing report.json and writing signature.json. This is NOT an ordinary unsigned ' +
      'report: ask for the complete export, and for the signature that was made over this manifest.',
  }
}

function presentSignatureVerdict(
  manifest: ReportManifest,
  signature: ReportSignatureFile,
  key: VerifyingKey,
): Verdict {
  const mismatch = fingerprintMismatch(manifest, signature, key)
  if (mismatch !== null) return { status: 'failed', detail: mismatch }
  if (!verifyReportManifestSignature(key.pem, manifest, signature.signatureBase64)) {
    return {
      status: 'failed',
      detail:
        'the ed25519 signature does not verify over this manifest. Either a field was changed after ' +
        'signing, or the signature was not produced over these bytes.',
    }
  }
  return {
    status: 'passed',
    detail:
      `valid ed25519 signature over the manifest, made by the key with fingerprint ${key.fingerprint}. ` +
      'The manifest commits to records.jsonl through records.sha256 and to summary.md through ' +
      'summary.sha256, so this covers those files too.',
  }
}

/**
 * Amendment A4. A scripted `verify --report && accept` cannot see the
 * UNSIGNED banner, and before the fixes in this round a wholly fabricated
 * unsigned bundle passed such a pipeline. `--require-signature` turns
 * "unsigned" and "could not be attributed" into findings; it never downgrades
 * a verdict, only escalates one.
 */
function escalateIfRequired(verdict: Verdict, requireSignature: boolean): Verdict {
  if (!requireSignature || verdict.status === 'passed' || verdict.status === 'failed') return verdict
  return {
    status: 'failed',
    detail:
      `${verdict.detail} FAILED because --require-signature was given: this run demands an export whose ` +
      'signature verifies against a public key, and this one is not provably attributable to any key.',
  }
}

/**
 * The fingerprint cross-check, run BEFORE the cryptographic verify. Both
 * copies of "which key signed this" -- the manifest's and the signature
 * file's -- must name the key actually supplied, or the signature is being
 * checked against a key nobody claimed produced it. First, so "you handed
 * me the wrong key" gets its own message instead of an indistinguishable
 * "signature does not verify".
 */
function fingerprintMismatch(
  manifest: ReportManifest,
  signature: ReportSignatureFile,
  key: VerifyingKey,
): string | null {
  if (manifest.keyFingerprint === undefined) {
    return (
      'signature.json is present but the manifest carries no keyFingerprint, so the manifest does not ' +
      'name the key that signed it. A signed export always stamps one.'
    )
  }
  if (manifest.keyFingerprint !== key.fingerprint) {
    return (
      `the manifest was signed by the key with fingerprint ${manifest.keyFingerprint}, but the supplied ` +
      `public key's fingerprint is ${key.fingerprint}. This is the wrong key for this report -- or this ` +
      'report did not come from the installation whose key you hold.'
    )
  }
  if (signature.keyFingerprint !== key.fingerprint) {
    return (
      `signature.json names the key fingerprint ${signature.keyFingerprint}, but the supplied public ` +
      `key's fingerprint is ${key.fingerprint}.`
    )
  }
  return null
}
