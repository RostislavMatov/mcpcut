import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../config.js'
import { canonicalJson } from '../policy/hash.js'
import { readFileIfExists } from '../vault/files.js'

/**
 * The installation's signing key and the chain-HEAD anchor it signs (M5
 * wave 4, tasks 4.2/4.3). This is the ONLY module in the codebase allowed to
 * touch Ed25519 / `node:crypto` signing primitives -- an architecture test
 * (a follow-up task) will enforce that the way `tests/architecture/
 * imports.test.ts` already enforces the `node:sqlite` boundary. Everything
 * here is kept deliberately narrow so that test can stay simple.
 *
 * O2 (owner decision): Ed25519 over HMAC-SHA256, specifically so an auditor
 * verifies with a PUBLIC key and the private key never has to leave this
 * host -- a symmetric scheme would require handing the auditor the same
 * secret used to write the journal, which defeats the point of a
 * third-party check. O1 (owner decision): no at-rest encryption of the key
 * file beyond filesystem permissions in M5 -- FileVault/LUKS is the
 * documented answer, not application-level key wrapping.
 *
 * Per-RECORD signing is explicitly out of scope (plan design decision, "Чего
 * в M5 НЕТ"): the hash chain (`chain.ts`) already binds every record to the
 * one before it, so signing the chain's HEAD attests the whole prefix a
 * verifier just walked. Signing every record would cost throughput (wave 3
 * already measured that budget as tight) without adding a property the
 * chain does not already provide.
 *
 * Honest threat model, repeated here because it is easy to forget while
 * reading crypto code: a signature proves the anchor was produced by
 * whoever holds `signing.key`. It does NOT prove no one has tampered with
 * the journal, because a process running under the SAME uid that wrote
 * `journal.db` can also read `signing.key` and re-sign a rewritten chain
 * end to end. The only thing that turns a signature into a tamper
 * DETECTOR is an operator keeping a copy of a past anchor somewhere this
 * host cannot also rewrite (out of band) and comparing it against a later
 * `verify --sign` run. `verify-cmd.ts` says this in its own output, not
 * only here.
 */

/** Filename for the installation's Ed25519 private key, under `JOURNAL_DIR`. */
export const SIGNING_KEY_FILENAME = 'signing.key'
/** Filename for the matching public key -- what gets handed to an auditor. */
export const SIGNING_PUB_FILENAME = 'signing.pub'

/**
 * Version of the chain-head anchor statement's own shape (field set and
 * serialization), independent of -- but expected to move in step with --
 * the wave 5 report's `formatVersion`. Bumping either is a breaking change
 * for anything that recomputes the canonical bytes to verify a signature.
 *
 * Bumped to 2 (review finding, M5 waves 3-4 review round): version 1 had no
 * field identifying WHICH key produced the anchor -- not a forgeability gap
 * (reproducing a `recordHash` requires the whole prior chain), but an
 * auditor handed only a public key had no way to assert "this anchor
 * belongs to this key" from the anchor's own content, and an operator
 * running several journal directories got anchors indistinguishable by
 * content alone. `keyFingerprint` closes that before the wave 5 export
 * manifest builds on this shape -- adding it later would mean a versioned
 * migration instead of one field.
 */
export const CHAIN_HEAD_ANCHOR_FORMAT_VERSION = 2

export function signingKeyPathFor(journalDir: string): string {
  return join(journalDir, SIGNING_KEY_FILENAME)
}

export function signingPubPathFor(journalDir: string): string {
  return join(journalDir, SIGNING_PUB_FILENAME)
}

/**
 * Raised by `generateAndWriteSigningKeyPair` when a key already exists.
 * Overwriting it would silently invalidate every anchor this installation
 * has ever signed -- a re-signed chain under a fresh key is indistinguishable
 * from a legitimate one to anyone who did not separately keep the OLD public
 * key, which defeats the entire point of an external anchor. Refusing is the
 * only safe default; deliberate key rotation (not built in M5) would need to
 * be an explicit, separately-named operation.
 */
export class SigningKeyExistsError extends Error {
  readonly existingPath: string

  /**
   * `partialPreviousRun`: the private key exists but the public key does
   * not -- a distinct case from a deliberate-rotation refusal, and given a
   * distinct message. The two writes below are sequential, not atomic as a
   * pair (review finding, M5 waves 3-4 review round): if the SECOND write
   * fails (disk full, say), a correctly-permissioned private key is left
   * with no public half, and the generic "refusing to overwrite, remove it
   * deliberately if rotation is intended" message would misdescribe that as
   * a rotation refusal. No auto-delete here -- deleting the private key
   * automatically risks destroying a GOOD key if the failure was actually
   * unrelated to disk space (e.g. a permissions problem hit only on the
   * second write); this is a message, not a recovery action, deliberately.
   */
  constructor(existingPath: string, opts: { readonly partialPreviousRun?: boolean } = {}) {
    super(
      opts.partialPreviousRun === true
        ? `the private key at "${existingPath}" exists but its matching public key does not -- ` +
            'this looks like a PREVIOUS "keygen" run that wrote the private half and then failed ' +
            'partway (e.g. disk full) before writing the public half, not a deliberate rotation. ' +
            'If you are certain no anchor was ever signed with this private key, remove it and ' +
            'run "mcpcut keygen" again; if in doubt, inspect it first rather than deleting it.'
        : `refusing to overwrite the existing signing key material at "${existingPath}" -- ` +
            'this would silently invalidate every anchor this installation has ever signed. ' +
            'Remove it deliberately first if rotation is really what is intended.',
    )
    this.name = 'SigningKeyExistsError'
    this.existingPath = existingPath
  }
}

export interface GeneratedSigningKeyPair {
  readonly privateKeyPath: string
  readonly publicKeyPath: string
  /** PEM text -- the one thing the operator must hand to an auditor. */
  readonly publicKeyPem: string
  /** sha256 hex of the SPKI DER -- see `publicKeyFingerprint`'s doc. Printed by `keygen` alongside the PEM so the operator can hand both over together. */
  readonly publicKeyFingerprint: string
}

/**
 * Generates a fresh Ed25519 keypair and writes both halves to disk under
 * `journalDir`. Refuses outright (before generating anything) if either file
 * already exists, so a refusal never touches the disk at all.
 *
 * The private key is created with `open(path, 'wx', JOURNAL_FILE_MODE)`:
 * exclusive creation ('wx' fails with EEXIST rather than truncating an
 * existing file) with the 0600 mode passed to `open` itself, not applied
 * afterwards with a separate `chmod`. A chmod-after-write leaves a real
 * window -- however short -- during which the file exists on disk at
 * whatever the process/directory umask happens to produce, potentially
 * world- or group-readable; `open`'s mode argument is applied atomically as
 * part of the file's creation, so there is no such window. Mirrors
 * `vault/files.ts`'s `writeAndSync`, which uses the same 'wx' + explicit
 * mode pattern for the vault's own key material.
 */
export async function generateAndWriteSigningKeyPair(
  journalDir: string,
): Promise<GeneratedSigningKeyPair> {
  const privateKeyPath = signingKeyPathFor(journalDir)
  const publicKeyPath = signingPubPathFor(journalDir)

  // Checked (and refused) before any key material is generated. There is a
  // narrow TOCTOU window between this check and the exclusive-create writes
  // below; the underlying 'wx' opens are still the actual safety net against
  // a second concurrent `keygen` (whichever loses the race gets EEXIST from
  // the OS), so this pre-check exists to fail fast and name the RIGHT file in
  // the common single-operator case, not to be the sole guard.
  const privateKeyAlreadyExists = (await readFileIfExists(privateKeyPath)) !== null
  const publicKeyAlreadyExists = (await readFileIfExists(publicKeyPath)) !== null
  if (privateKeyAlreadyExists) {
    // Distinguishes "a previous run wrote the private half and then failed
    // before the public half" from a deliberate-rotation refusal -- see
    // `SigningKeyExistsError`'s doc.
    throw new SigningKeyExistsError(privateKeyPath, { partialPreviousRun: !publicKeyAlreadyExists })
  }
  if (publicKeyAlreadyExists) {
    throw new SigningKeyExistsError(publicKeyPath)
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })

  await mkdir(journalDir, { recursive: true, mode: JOURNAL_DIR_MODE })
  await createFileExclusive(privateKeyPath, privateKey)
  await createFileExclusive(publicKeyPath, publicKey)

  return {
    privateKeyPath,
    publicKeyPath,
    publicKeyPem: publicKey,
    publicKeyFingerprint: publicKeyFingerprint(publicKey),
  }
}

/** Exclusive create at `JOURNAL_FILE_MODE` (0600), fsynced before the handle closes. */
async function createFileExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', JOURNAL_FILE_MODE)
  try {
    await handle.writeFile(content, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * The honest result of looking for a signing key: `{ present: false }` when
 * there is none, modeled as a distinct branch of the type rather than left
 * to a caller's convention (a `string | undefined` return, or worse, an
 * empty string) so nothing downstream can mistake "no key" for a key whose
 * PEM happens to be falsy. A caller that pattern-matches this type cannot
 * accidentally fall through to treating an absent key as present -- the
 * `present: true` branch is the only one carrying `privateKeyPem` at all.
 * This is the type-level answer to "a silent unsigned fallback is
 * forbidden": there is no code path that can construct a signed-looking
 * result without a real key present.
 */
export type SigningPrivateKeyLookup =
  | { readonly present: true; readonly privateKeyPem: string }
  | { readonly present: false }

export async function loadSigningPrivateKey(journalDir: string): Promise<SigningPrivateKeyLookup> {
  const pem = await readFileIfExists(signingKeyPathFor(journalDir))
  return pem === null ? { present: false } : { present: true, privateKeyPem: pem }
}

/** `null` when no key has been generated yet -- mirrors `loadSigningPrivateKey`'s honesty for the public half. */
export async function loadSigningPublicKey(journalDir: string): Promise<string | null> {
  return readFileIfExists(signingPubPathFor(journalDir))
}

/**
 * The statement `verify --sign` signs: the chain's HEAD, not a record.
 * `formatVersion` is separate from (but expected to track) the wave 5
 * report's own `formatVersion` -- see this module's top doc.
 */
export interface ChainHeadAnchor {
  readonly formatVersion: number
  readonly seq: number
  readonly recordHash: string
  /** ISO 8601 timestamp of when the anchor was produced, not of the record itself. */
  readonly signedAt: string
  /**
   * sha256 hex of the SIGNING key's SPKI DER (`publicKeyFingerprint`) --
   * identifies WHICH key produced this anchor, so an auditor holding several
   * public keys (or an operator running several journal directories) can
   * tell which one to verify against before even trying. Always derived
   * from the private key that actually signs (`signChainHeadAnchor`), never
   * accepted as caller input -- see that function's doc.
   */
  readonly keyFingerprint: string
}

/** What a caller builds BEFORE signing: everything `ChainHeadAnchor` has except `keyFingerprint`, which `signChainHeadAnchor` derives itself. */
export type UnsignedChainHeadAnchor = Omit<ChainHeadAnchor, 'keyFingerprint'>

/**
 * The exact bytes that get signed. `canonicalJson` (`policy/hash.ts`) fits
 * here, unlike `chain.ts`'s record-hash link (which hashes `doc` as stored
 * bytes, verbatim): an anchor is a small, FLAT, entirely control-plane-owned
 * object with no attacker-influenced string values and no nested structure --
 * exactly the case `canonicalJson`'s key-sorting exists for, so a third
 * party who is handed the field values (not this string) reproduces this
 * exact text by re-serializing them the same documented way, with no
 * embedded `doc` bytes to reproduce byte-for-byte instead.
 */
export function canonicalChainHeadAnchorBytes(anchor: ChainHeadAnchor): string {
  return canonicalJson(anchor)
}

export interface SignedChainHeadAnchor {
  readonly anchor: ChainHeadAnchor
  /** The exact bytes signed, for a caller that wants to echo them verbatim (e.g. into an operator's out-of-band record). */
  readonly canonicalBytes: string
  readonly signatureBase64: string
}

/**
 * sha256 hex of a public key's SPKI DER encoding -- what an operator can
 * independently reproduce with `openssl pkey -pubin -in signing.pub -outform
 * DER | openssl dgst -sha256`, without this project's own tooling. SPKI DER
 * (not the PEM text) so re-wrapping/re-line-wrapping a PEM -- whitespace
 * only, semantically identical -- never changes the fingerprint; sha256 hex
 * matches this codebase's other content hashes (`policy/hash.ts`'s
 * `sha256Hex`) rather than introducing a different digest or encoding.
 */
export function publicKeyFingerprint(publicKeyPem: string): string {
  return fingerprintOfSpkiDer(createPublicKey(publicKeyPem))
}

/** Shared by `publicKeyFingerprint` and `signChainHeadAnchor`: both ultimately hash the same SPKI DER encoding of a public key. */
function fingerprintOfSpkiDer(publicKeyObject: ReturnType<typeof createPublicKey>): string {
  const der = publicKeyObject.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex')
}

/**
 * The fingerprint of the PRIVATE key's own matching public half, derived
 * in-process from `privateKeyPem` itself (`createPrivateKey` then
 * `createPublicKey` on the resulting `KeyObject`, the documented way Node
 * derives a public key from a private one) -- never from a caller-supplied
 * public PEM or fingerprint string, and never from the `signing.pub` file.
 * This is what makes `signChainHeadAnchor`'s `keyFingerprint` trustworthy:
 * it can only ever name the key that ACTUALLY produced the signature below
 * it, not a caller's separate claim about which key that was.
 *
 * Exported for `report-signing.ts` (M5 wave 5), the report manifest's
 * signer: that module must derive its `keyFingerprint` under exactly this
 * rule, and reaching it through this one function is what guarantees the
 * two signers cannot drift into deriving the fingerprint two different
 * ways -- or, worse, into one of them accepting the caller's word for it.
 */
export function privateKeyFingerprint(privateKeyPem: string): string {
  return fingerprintOfSpkiDer(createPublicKey(createPrivateKey(privateKeyPem)))
}

/**
 * The asymmetric algorithm a private key PEM actually holds -- `'ed25519'`
 * for this installation's own keys, `'rsa'`/`'ec'`/... for anything else,
 * and `'unknown'` for a key Node cannot classify.
 *
 * Exported for `report-signing.ts` (M5 wave 5, review round) for the same
 * reason `privateKeyFingerprint` is: a signature file states the algorithm an
 * auditor will verify with, and the review found that field ASSERTED rather
 * than derived -- signing a manifest with an RSA key produced a file claiming
 * `ed25519`, so an auditor verifying independently (openssl, a GRC tool)
 * follows the stated algorithm and gets a wrong answer about evidence. The
 * derivation lives here, beside the fingerprint derivation, because
 * `report-signing.ts` is forbidden from importing key-import primitives
 * itself (`tests/architecture/imports.test.ts`).
 */
export function privateKeyAlgorithm(privateKeyPem: string): string {
  return createPrivateKey(privateKeyPem).asymmetricKeyType ?? 'unknown'
}

/**
 * Signs a chain-head anchor with the installation's Ed25519 private key.
 * Ed25519 (unlike RSA/ECDSA) signs the message directly -- no separate
 * digest algorithm is selected, hence the `null` first argument to
 * `crypto.sign`/`crypto.verify` below, which is the documented Node API
 * shape for this algorithm.
 */
export function signChainHeadAnchor(
  privateKeyPem: string,
  anchor: UnsignedChainHeadAnchor,
): SignedChainHeadAnchor {
  const fullAnchor: ChainHeadAnchor = { ...anchor, keyFingerprint: privateKeyFingerprint(privateKeyPem) }
  const canonicalBytes = canonicalChainHeadAnchorBytes(fullAnchor)
  const signatureBase64 = cryptoSign(null, Buffer.from(canonicalBytes, 'utf8'), privateKeyPem).toString(
    'base64',
  )
  return { anchor: fullAnchor, canonicalBytes, signatureBase64 }
}

/**
 * Verifies a chain-head anchor's signature against a public key. Recomputes
 * the canonical bytes from the anchor's OWN fields rather than trusting a
 * caller-supplied `canonicalBytes` string -- this is what makes the check a
 * genuine verification of "did these field values produce this signature",
 * not "does this opaque string match", and it is exactly what a third party
 * reproducing the bytes independently (rather than trusting a copy handed to
 * them) would do.
 *
 * Never throws: malformed base64, a malformed/foreign PEM, or a
 * wrong-algorithm key all collapse into `false`, the same contract
 * `security/token.ts`'s `verifyToken` uses -- a verification predicate should
 * have exactly one failure mode its caller has to handle.
 */
export function verifyChainHeadAnchorSignature(
  publicKeyPem: string,
  anchor: ChainHeadAnchor,
  signatureBase64: string,
): boolean {
  try {
    const canonicalBytes = canonicalChainHeadAnchorBytes(anchor)
    return cryptoVerify(
      null,
      Buffer.from(canonicalBytes, 'utf8'),
      publicKeyPem,
      Buffer.from(signatureBase64, 'base64'),
    )
  } catch {
    return false
  }
}
