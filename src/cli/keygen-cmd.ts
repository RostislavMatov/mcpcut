import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import {
  SigningKeyExistsError,
  generateAndWriteSigningKeyPair,
} from '../journal/signing.js'

/**
 * `mcp-journal keygen` (M5 wave 4, task 4.2): generates this installation's
 * Ed25519 signing key. Mirrors `admin add`'s shape (`admin-cmd.ts`): a
 * secret is minted, and the ONE thing that ever reaches stdout is the public
 * half -- the private key is written straight to disk and never echoed
 * anywhere, including in this command's own error paths (see
 * `journal/signing.ts`'s `SigningKeyExistsError`, which names a PATH, never
 * key material).
 */

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
}

const USAGE =
  'Usage: mcp-journal keygen\n' +
  'Generates this installation\'s Ed25519 signing key (used by "verify --sign").\n' +
  'Refuses to run if a key already exists -- overwriting it would invalidate every\n' +
  'anchor this installation has ever signed. There is no --force: deliberate key\n' +
  'rotation is not built in M5.\n' +
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

  const journalDir = opts.journalDir ?? JOURNAL_DIR
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
    return 0
  } catch (error: unknown) {
    if (error instanceof SigningKeyExistsError) {
      io.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }
}
