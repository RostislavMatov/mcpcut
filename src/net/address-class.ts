import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net'

/**
 * Address classifier behind the tenant-mode SSRF guard (`./upstream-guard.ts`,
 * ADR-0017 T4): given an IP address — never a name — say whether a hosted
 * install may dial it, and if not, which kind of non-public address it is.
 *
 * Every decision is made on a parsed address, never on a string prefix.
 * Security review 2026-09-21 (CRITICAL, `src/setup/bind-checks.ts`):
 * `'127.'.startsWith` matched `127.evil.com`. Here a non-IP input throws, so a
 * caller that forgot to resolve a name fails loudly instead of being waved
 * through.
 *
 * The special-purpose ranges are DATA (IANA IPv4/IPv6 Special-Purpose Address
 * Registries), checked in order through `net.BlockList`. IPv6 addresses that
 * carry an IPv4 inside (mapped, translated, compatible, NAT64, 6to4) are
 * unwrapped by hand and judged by the inner address: `BlockList` does match
 * an IPv4-mapped address against IPv4 rules (verified on Node 24.21 and 25.6),
 * but it knows nothing of the other embeddings, and one explicit rule is
 * easier to audit than a partial built-in one. IPv4 and IPv6 rules live in
 * separate lists because `BlockList` also works the other way round: an IPv6
 * rule `::ffff:0:0/96` matches EVERY IPv4 address checked as `ipv4`.
 */

/** Why an address is refused. */
export type AddressRefusal =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'shared'
  | 'unspecified'
  | 'multicast'
  | 'reserved'
  | 'documentation'

export type AddressClass =
  | Readonly<{ kind: 'public' }>
  | Readonly<{ kind: 'refused'; reason: AddressRefusal }>

type Family = 'ipv4' | 'ipv6'

interface RangeRule {
  readonly subnet: string
  readonly prefix: number
  readonly reason: AddressRefusal
}

/** IANA IPv4 Special-Purpose Address Registry: every block that is not globally reachable. */
const IPV4_RULES: readonly RangeRule[] = [
  { subnet: '0.0.0.0', prefix: 8, reason: 'unspecified' },
  { subnet: '10.0.0.0', prefix: 8, reason: 'private' },
  { subnet: '100.64.0.0', prefix: 10, reason: 'shared' },
  { subnet: '127.0.0.0', prefix: 8, reason: 'loopback' },
  { subnet: '169.254.0.0', prefix: 16, reason: 'link-local' },
  { subnet: '172.16.0.0', prefix: 12, reason: 'private' },
  { subnet: '192.0.0.0', prefix: 24, reason: 'reserved' },
  { subnet: '192.0.2.0', prefix: 24, reason: 'documentation' },
  { subnet: '192.88.99.0', prefix: 24, reason: 'reserved' },
  { subnet: '192.168.0.0', prefix: 16, reason: 'private' },
  { subnet: '198.18.0.0', prefix: 15, reason: 'reserved' },
  { subnet: '198.51.100.0', prefix: 24, reason: 'documentation' },
  { subnet: '203.0.113.0', prefix: 24, reason: 'documentation' },
  { subnet: '224.0.0.0', prefix: 4, reason: 'multicast' },
  { subnet: '240.0.0.0', prefix: 4, reason: 'reserved' },
]

/**
 * IPv6 ranges refused with a specific reason. Checked BEFORE the embedded-IPv4
 * unwrap, so `::` and `::1` keep their own meaning instead of reading as the
 * IPv4-compatible `0.0.0.0` / `0.0.0.1`. Anything that survives this table and
 * the unwrap must still sit in `2000::/3` (global unicast) to be public.
 */
const IPV6_RULES: readonly RangeRule[] = [
  { subnet: '::', prefix: 128, reason: 'unspecified' },
  { subnet: '::1', prefix: 128, reason: 'loopback' },
  { subnet: '64:ff9b:1::', prefix: 48, reason: 'reserved' },
  { subnet: '100::', prefix: 64, reason: 'reserved' },
  // Teredo: the client IPv4 inside is obfuscated and may point anywhere.
  { subnet: '2001::', prefix: 32, reason: 'reserved' },
  // IETF Protocol Assignments — IANA: not globally reachable "unless allowed by
  // a more specific allocation". The allocations inside (registry 2025-10-09):
  // PCP/TURN/DNS-SD anycast 2001:1::1–3, benchmarking 2001:2::/48, AMT
  // 2001:3::/32, AS112-v6 2001:4:112::/48, ORCHID 2001:10::/28 (deprecated),
  // ORCHIDv2 2001:20::/28, DRIP 2001:30::/28. Some are marked globally
  // reachable, but none is where an application server lives — anycast
  // protocol infrastructure, a DNS sink, or identifiers rather than locators —
  // so the block is refused whole (security review L1). Benchmarking is
  // `reserved`, like its IPv4 twin 198.18.0.0/15.
  { subnet: '2001::', prefix: 23, reason: 'reserved' },
  { subnet: '2001:db8::', prefix: 32, reason: 'documentation' },
  { subnet: '3fff::', prefix: 20, reason: 'documentation' },
  { subnet: 'fc00::', prefix: 7, reason: 'private' },
  { subnet: 'fe80::', prefix: 10, reason: 'link-local' },
  // Site-local: deprecated, never routed globally — a private network in practice.
  { subnet: 'fec0::', prefix: 10, reason: 'private' },
  { subnet: 'ff00::', prefix: 8, reason: 'multicast' },
]

/**
 * IPv6 global unicast `2000::/3`; everything else left after the table is
 * reserved — including the registry's 100:0:0:1::/64 (dummy prefix) and
 * 5f00::/16 (SRv6 SIDs), which therefore need no row of their own.
 */
const IPV6_GLOBAL_UNICAST = { subnet: '2000::', prefix: 3 } as const

/**
 * IPv6 forms carrying an IPv4: the leading 16-bit groups that identify the
 * form and the group index where the 32-bit IPv4 starts.
 */
interface Embedding {
  readonly lead: readonly number[]
  readonly at: number
}

const EMBEDDINGS: readonly Embedding[] = [
  { lead: [0, 0, 0, 0, 0, 0xffff], at: 6 }, // IPv4-mapped ::ffff:a.b.c.d
  { lead: [0, 0, 0, 0, 0xffff, 0], at: 6 }, // IPv4-translated ::ffff:0:a.b.c.d
  { lead: [0, 0, 0, 0, 0, 0], at: 6 }, // IPv4-compatible ::a.b.c.d (deprecated)
  { lead: [0x64, 0xff9b, 0, 0, 0, 0], at: 6 }, // NAT64 64:ff9b::/96
  { lead: [0x2002], at: 1 }, // 6to4 2002:AABB:CCDD::/48
]

interface CompiledRule {
  readonly list: BlockList
  readonly reason: AddressRefusal
}

function compile(rules: readonly RangeRule[], family: Family): readonly CompiledRule[] {
  return Object.freeze(
    rules.map((rule) => {
      const list = new BlockList()
      list.addSubnet(rule.subnet, rule.prefix, family)
      return Object.freeze({ list, reason: rule.reason })
    }),
  )
}

const IPV4_LISTS = compile(IPV4_RULES, 'ipv4')
const IPV6_LISTS = compile(IPV6_RULES, 'ipv6')
const IPV6_GLOBAL_LIST = new BlockList()
IPV6_GLOBAL_LIST.addSubnet(IPV6_GLOBAL_UNICAST.subnet, IPV6_GLOBAL_UNICAST.prefix, 'ipv6')

const PUBLIC: AddressClass = Object.freeze({ kind: 'public' })

function refused(reason: AddressRefusal): AddressClass {
  return Object.freeze({ kind: 'refused', reason })
}

function firstMatch(
  lists: readonly CompiledRule[],
  address: string,
  family: Family,
): AddressRefusal | undefined {
  return lists.find((rule) => rule.list.check(address, family))?.reason
}

/**
 * Classifies one IP address. Throws `TypeError` for anything that is not an
 * IPv4 or IPv6 literal (names included — resolve first). An IPv6 zone
 * (`fe80::1%eth0`) is dropped before the check; brackets are not accepted.
 */
export function classifyAddress(ip: string): AddressClass {
  const address = withoutZone(ip).toLowerCase()
  if (isIPv4(address)) return classifyIPv4(address)
  if (isIPv6(address)) return classifyIPv6(address)
  throw new TypeError(`not an IP address: ${JSON.stringify(ip)}`)
}

function classifyIPv4(address: string): AddressClass {
  const reason = firstMatch(IPV4_LISTS, address, 'ipv4')
  return reason === undefined ? PUBLIC : refused(reason)
}

function classifyIPv6(address: string): AddressClass {
  const reason = firstMatch(IPV6_LISTS, address, 'ipv6')
  if (reason !== undefined) return refused(reason)
  const inner = embeddedIPv4(ipv6Groups(address))
  if (inner !== undefined) return classifyIPv4(inner)
  return IPV6_GLOBAL_LIST.check(address, 'ipv6') ? PUBLIC : refused('reserved')
}

/** Drops an IPv6 zone id; an IPv4 with a `%` stays as is and fails the IP check. */
function withoutZone(ip: string): string {
  const percent = ip.indexOf('%')
  if (percent === -1) return ip
  const bare = ip.slice(0, percent)
  return isIPv6(bare) ? bare : ip
}

function embeddedIPv4(groups: readonly number[]): string | undefined {
  const form = EMBEDDINGS.find((e) => e.lead.every((value, i) => groups[i] === value))
  if (form === undefined) return undefined
  const high = groups[form.at] ?? 0
  const low = groups[form.at + 1] ?? 0
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

/**
 * The eight 16-bit groups of an address `net.isIPv6` has already accepted
 * (lower-case, no zone). Handles `::` compression and a trailing dotted IPv4.
 */
function ipv6Groups(address: string): readonly number[] {
  const [head = '', tail] = address.split('::')
  const left = hexGroups(head)
  const right = tail === undefined ? [] : hexGroups(tail)
  const zeros = new Array<number>(8 - left.length - right.length).fill(0)
  return [...left, ...zeros, ...right]
}

function hexGroups(part: string): readonly number[] {
  if (part === '') return []
  return part
    .split(':')
    .flatMap((group) => (isIP(group) === 4 ? dottedToGroups(group) : [parseInt(group, 16)]))
}

function dottedToGroups(dotted: string): readonly number[] {
  const [a = 0, b = 0, c = 0, d = 0] = dotted.split('.').map(Number)
  return [(a << 8) | b, (c << 8) | d]
}
