import { sha256Hex } from '../policy/hash.js'

/**
 * The hash-chain link function (M5 wave 3). Pure and SQL-free by design: how
 * a link is computed and how it is folded across a batch/committed to
 * `journal_records` are separate concerns — the fold and the "read the chain
 * head inside the transaction" invariant live in `db.ts`'s
 * `insertRecordRows`, the ONLY caller of `linkHashOf`. See that function's
 * doc for why the head read must never be hoisted outside `BEGIN IMMEDIATE`.
 *
 * The hash covers the STORED `doc` STRING byte-for-byte, not a canonical
 * JSON re-serialization of it (contrast `policy/hash.ts`'s `canonicalJson`,
 * used for `policyHash`/`grantsHash`, where two byte-different-but-equivalent
 * representations of the SAME semantic document must hash the same). `doc`
 * is exactly what `export` emits verbatim (`export-cmd.ts`), so an auditor
 * re-hashing the bytes they actually received reproduces this digest without
 * having to also reimplement this project's canonicalization rules — the
 * chain's integrity claim is about the bytes on the wire, not a reinterpreted
 * view of them.
 */

/**
 * `prev_hash` of the first chained record a database ever writes. Also what
 * a database with pre-chain (`NULL`-hash) rows uses as its head once the
 * first chained insert lands: see `insertRecordRows`'s head query, which
 * deliberately ignores `NULL` rows rather than inheriting one as a "head".
 */
export const GENESIS_PREV_HASH = ''

/**
 * One chain link: `sha256Hex(prevHash + '\n' + sha256Hex(doc))`. `doc` is
 * hashed first and separately, rather than concatenated with `prevHash`
 * raw, so a `doc` that happens to contain the `\n` separator (or a value
 * shaped like a 64-hex-char prior hash) cannot be crafted to make two
 * different `(prevHash, doc)` pairs collide on the same input string before
 * the outer hash ever sees it.
 *
 * Binding `prevHash` into the digest is what turns a set of row hashes into
 * a CHAIN: the same `doc` inserted at two different chain positions yields
 * two different `recordHash` values (position/order is part of what is
 * attested), and an edited, reordered, or deleted row breaks every
 * `recordHash` computed after it — the property `verify` (a later wave)
 * walks to detect tampering.
 */
export function linkHashOf(prevHash: string, doc: string): string {
  return sha256Hex(`${prevHash}\n${sha256Hex(doc)}`)
}
