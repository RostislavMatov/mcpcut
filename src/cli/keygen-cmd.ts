import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import {
  SigningKeyExistsError,
  generateAndWriteSigningKeyPair,
  loadSigningPrivateKey,
  loadSigningPublicKey,
  privateKeyFingerprint,
  publicKeyFingerprint,
  signingKeyPathFor,
} from '../journal/signing.js'
import { replaceControlChars } from '../journal/format.js'
import type { AdminRefusalWording } from './admin-token.js'
import { adminOf, recordHostOp, resolveHostOpActor } from './host-op-write.js'
import { exportReportHint } from './next-step.js'

/**
 * `mcpcut keygen` (M5 wave 4, task 4.2): generates this installation's
 * Ed25519 signing key. Mirrors `admin add`'s shape (`admin-cmd.ts`): a
 * secret is minted, and the ONE thing that ever reaches stdout is the public
 * half -- the private key is written straight to disk and never echoed
 * anywhere, including in this command's own error paths (see
 * `journal/signing.ts`'s `SigningKeyExistsError`, which names a PATH, never
 * key material).
 *
 * NOT gated (owner decision Q17, 2026-09-08): the key is minted on an install
 * that may have no admin at all — `setup` runs this before the first admin
 * exists. But when a valid `MCP_ADMIN_TOKEN` IS present the mint is recorded
 * as an `access-edit` naming the admin and the key's public fingerprint; an
 * unusable token is refused before anything is written.
 */

/** How the optional token gate names a refusal. */
const KEYGEN_REFUSAL: AdminRefusalWording = {
  action: 'generate the signing key',
  noun: 'key',
  verb: 'may not generate the signing key',
}

export interface KeygenCliWritable {
  write(chunk: string): unknown
}

export interface KeygenCliIo {
  readonly stdout: KeygenCliWritable
  readonly stderr: KeygenCliWritable
}

/** Test seam: journal directory override, same convention as `verify-cmd.ts`. */
export interface KeygenCommandOptions {
  readonly journalDir?: string
  /** Environment holding an OPTIONAL `MCP_ADMIN_TOKEN`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

const USAGE =
  'Usage: mcpcut keygen\n' +
  'Generates this installation\'s Ed25519 signing key (used by "verify --sign").\n' +
  'A key that already exists is kept and named, never overwritten -- that would\n' +
  'invalidate every anchor this installation has ever signed -- and the run still\n' +
  'succeeds, so "keygen && export --report" can be run again. There is no --force:\n' +
  'deliberate key rotation is not built in M5.\n' +
  'If signing.key exists but signing.pub does not, a previous run likely failed\n' +
  'partway (e.g. disk full) rather than this being a deliberate rotation --\n' +
  'the refusal message explains what to check before deleting anything.\n'

const DEFAULT_IO: KeygenCliIo = { stdout: process.stdout, stderr: process.stderr }

export async function runKeygenCommand(
  args: readonly string[],
  io: KeygenCliIo = DEFAULT_IO,
  opts: KeygenCommandOptions = {},
): Promise<number> {
  const { positionals } = parseArgs({ args: [...args], options: {}, allowPositionals: true })
  if (positionals.length > 0) {
    io.stderr.write(`keygen takes no arguments (got: ${positionals.join(' ')})\n\n${USAGE}`)
    return 1
  }

  // Before the key is minted: an unusable token must not be discovered after
  // an installation has an identity it did not mean to create.
  const resolved = await resolveHostOpActor(io, opts, KEYGEN_REFUSAL)
  if (resolved.kind === 'refused') return 1

  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const kept = await existingKeyPair(journalDir)
  if (kept !== null) {
    io.stdout.write(`A signing key already exists, kept as is: ${replaceControlChars(kept.privateKeyPath)}\n`)
    io.stdout.write(`Fingerprint (sha256 of SPKI DER, hex): ${kept.fingerprint}\n`)
    io.stderr.write(exportReportHint())
    return 0
  }
  try {
    const generated = await generateAndWriteSigningKeyPair(journalDir)
    io.stdout.write(`Signing key written to: ${generated.privateKeyPath}\n`)
    io.stdout.write(`Public key written to:  ${generated.publicKeyPath}\n\n`)
    io.stdout.write('Public key (hand this to your auditor):\n')
    io.stdout.write(`${generated.publicKeyPem}\n`)
    // Handed over alongside the PEM, not only inside a later `verify --sign`
    // anchor: an auditor (or an operator running several journal
    // directories) needs a way to tell keys apart by content BEFORE any
    // anchor has been signed with this one.
    io.stdout.write(`Fingerprint (sha256 of SPKI DER, hex): ${generated.publicKeyFingerprint}\n`)
    await recordHostOp(io, opts, adminOf(resolved), {
      op: 'keygen',
      action: 'keygen',
      target: generated.publicKeyFingerprint,
      keyFingerprint: generated.publicKeyFingerprint,
    })
    io.stderr.write(exportReportHint())
    return 0
  } catch (error: unknown) {
    if (error instanceof SigningKeyExistsError) {
      io.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }
}

interface ExistingKeyPair {
  readonly privateKeyPath: string
  readonly fingerprint: string
}

/**
 * A working pair already on disk: the key to keep (0.2.3 — the Quick start's
 * `keygen && export --report` must survive a second run). Working means the
 * private key parses and derives exactly the public key in `signing.pub`
 * (0.2.3 review: a garbled or foreign half must not be reported as kept and
 * fail later in `verify --sign`). The private key is read into memory for
 * that comparison only — nothing of it is printed. Anything else goes on to
 * `generateAndWriteSigningKeyPair`, whose refusals name the file to check.
 */
async function existingKeyPair(journalDir: string): Promise<ExistingKeyPair | null> {
  const publicKeyPem = await loadSigningPublicKey(journalDir)
  if (publicKeyPem === null) return null
  const privateKey = await loadSigningPrivateKey(journalDir)
  if (!privateKey.present) return null
  try {
    const fingerprint = publicKeyFingerprint(publicKeyPem)
    if (privateKeyFingerprint(privateKey.privateKeyPem) !== fingerprint) return null
    return { privateKeyPath: signingKeyPathFor(journalDir), fingerprint }
  } catch {
    // Unparseable PEM: not a pair to keep; the refusal path explains.
    return null
  }
}
