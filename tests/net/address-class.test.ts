import { describe, expect, test } from 'vitest'
import { classifyAddress, type AddressRefusal } from '../../src/net/address-class.js'

/**
 * Tenant mode Task 3: the address classifier behind the SSRF guard
 * (`src/net/upstream-guard.ts`). Every special-purpose range is pinned at its
 * edges — first address, last address, and the neighbour just outside — so a
 * mistyped prefix length shows up as a failing row, not as a silent hole.
 */

type Row = readonly [address: string, expected: 'public' | AddressRefusal]

const IPV4_ROWS: readonly Row[] = [
  // 0.0.0.0/8 unspecified ("this network")
  ['0.0.0.0', 'unspecified'],
  ['0.255.255.255', 'unspecified'],
  ['1.0.0.0', 'public'],
  // 10.0.0.0/8 private
  ['9.255.255.255', 'public'],
  ['10.0.0.0', 'private'],
  ['10.255.255.255', 'private'],
  ['11.0.0.0', 'public'],
  // 100.64.0.0/10 shared (carrier-grade NAT)
  ['100.63.255.255', 'public'],
  ['100.64.0.0', 'shared'],
  ['100.64.0.1', 'shared'],
  ['100.127.255.255', 'shared'],
  ['100.128.0.1', 'public'],
  // 127.0.0.0/8 loopback
  ['126.255.255.255', 'public'],
  ['127.0.0.0', 'loopback'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.255', 'loopback'],
  ['128.0.0.0', 'public'],
  // 169.254.0.0/16 link-local (cloud metadata lives here)
  ['169.253.255.255', 'public'],
  ['169.254.0.0', 'link-local'],
  ['169.254.169.254', 'link-local'],
  ['169.254.255.255', 'link-local'],
  ['169.255.0.0', 'public'],
  // 172.16.0.0/12 private
  ['172.15.255.255', 'public'],
  ['172.16.0.0', 'private'],
  ['172.31.255.255', 'private'],
  ['172.32.0.0', 'public'],
  // 192.0.0.0/24 reserved (IETF protocol assignments)
  ['191.255.255.255', 'public'],
  ['192.0.0.0', 'reserved'],
  ['192.0.0.255', 'reserved'],
  ['192.0.1.0', 'public'],
  // 192.0.2.0/24 documentation (TEST-NET-1)
  ['192.0.2.0', 'documentation'],
  ['192.0.2.255', 'documentation'],
  ['192.0.3.0', 'public'],
  // 192.88.99.0/24 reserved (deprecated 6to4 relay anycast)
  ['192.88.99.1', 'reserved'],
  ['192.88.100.0', 'public'],
  // 192.168.0.0/16 private
  ['192.167.255.255', 'public'],
  ['192.168.0.0', 'private'],
  ['192.168.255.255', 'private'],
  ['192.169.0.0', 'public'],
  // 198.18.0.0/15 reserved (benchmarking)
  ['198.17.255.255', 'public'],
  ['198.18.0.0', 'reserved'],
  ['198.19.255.255', 'reserved'],
  ['198.20.0.0', 'public'],
  // 198.51.100.0/24 documentation (TEST-NET-2)
  ['198.51.99.255', 'public'],
  ['198.51.100.0', 'documentation'],
  ['198.51.100.255', 'documentation'],
  ['198.51.101.0', 'public'],
  // 203.0.113.0/24 documentation (TEST-NET-3)
  ['203.0.112.255', 'public'],
  ['203.0.113.0', 'documentation'],
  ['203.0.113.255', 'documentation'],
  ['203.0.114.0', 'public'],
  // 224.0.0.0/4 multicast
  ['223.255.255.255', 'public'],
  ['224.0.0.0', 'multicast'],
  ['239.255.255.255', 'multicast'],
  // 240.0.0.0/4 reserved, including limited broadcast
  ['240.0.0.0', 'reserved'],
  ['255.255.255.255', 'reserved'],
  // ordinary public addresses
  ['1.1.1.1', 'public'],
  ['8.8.8.8', 'public'],
]

const IPV6_ROWS: readonly Row[] = [
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['0:0:0:0:0:0:0:1', 'loopback'],
  // fc00::/7 unique local — AWS IMDS answers on fd00:ec2::254
  ['fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'reserved'],
  ['fc00::', 'private'],
  ['fd00:ec2::254', 'private'],
  ['FD00:EC2::254', 'private'],
  ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'private'],
  // fe80::/10 link-local, with and without a zone
  ['fe80::', 'link-local'],
  ['fe80::1', 'link-local'],
  ['fe80::1%eth0', 'link-local'],
  ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'link-local'],
  // fec0::/10 site-local (deprecated, never globally routed)
  ['fec0::1', 'private'],
  // ff00::/8 multicast
  ['ff00::', 'multicast'],
  ['ff02::1', 'multicast'],
  // 2001:db8::/32 and 3fff::/20 documentation
  ['2001:db8::', 'documentation'],
  ['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', 'documentation'],
  ['2001:db9::1', 'public'],
  ['3fff::1', 'documentation'],
  // 100::/64 discard-only
  ['100::', 'reserved'],
  ['100::ffff:ffff:ffff:ffff', 'reserved'],
  ['100:0:0:1::', 'reserved'],
  // 2001::/32 Teredo: the embedded client address is obfuscated, refuse whole
  ['2001::1', 'reserved'],
  // 2001::/23 IETF Protocol Assignments (security review L1). IANA: "not
  // globally reachable unless allowed by a more specific allocation"; none of
  // those allocations is an application server, so the whole block is refused.
  ['2001:1::1', 'reserved'], // PCP anycast
  ['2001:1::2', 'reserved'], // TURN anycast
  ['2001:1::3', 'reserved'], // DNS-SD SRP anycast
  ['2001:2::', 'reserved'], // 2001:2::/48 benchmarking
  ['2001:2:0:ffff:ffff:ffff:ffff:ffff', 'reserved'],
  ['2001:3::', 'reserved'], // 2001:3::/32 AMT
  ['2001:3:ffff:ffff:ffff:ffff:ffff:ffff', 'reserved'],
  ['2001:4:112::', 'reserved'], // 2001:4:112::/48 AS112-v6
  ['2001:4:112:ffff:ffff:ffff:ffff:ffff', 'reserved'],
  ['2001:10::1', 'reserved'], // 2001:10::/28 deprecated ORCHID
  ['2001:20::', 'reserved'], // 2001:20::/28 ORCHIDv2
  ['2001:2f:ffff:ffff:ffff:ffff:ffff:ffff', 'reserved'],
  ['2001:30::', 'reserved'], // 2001:30::/28 DRIP entity tags
  ['2001:3f:ffff:ffff:ffff:ffff:ffff:ffff', 'reserved'],
  ['2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', 'reserved'], // last address of the /23
  ['2001:200::', 'public'], // first address past it (RIR space)
  // 5f00::/16 SRv6 SIDs and 100:0:0:1::/64 dummy prefix: outside 2000::/3
  ['5f00::', 'reserved'],
  ['5fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'reserved'],
  ['100:0:0:1:ffff:ffff:ffff:ffff', 'reserved'],
  // 64:ff9b:1::/48 local-use NAT64
  ['64:ff9b:1::a00:1', 'reserved'],
  // outside 2000::/3 global unicast
  ['1000::1', 'reserved'],
  ['4000::1', 'reserved'],
  // ordinary public addresses
  ['2606:4700::1111', 'public'],
  ['2a00:1450:4001:80b::200e', 'public'],
]

/** Addresses that carry an IPv4 inside; the verdict must be the inner address's. */
const EMBEDDED_ROWS: readonly Row[] = [
  // IPv4-mapped, dotted and hex spellings
  ['::ffff:127.0.0.1', 'loopback'],
  ['::ffff:7f00:1', 'loopback'],
  ['::FFFF:7F00:1', 'loopback'],
  ['::ffff:169.254.169.254', 'link-local'],
  ['::ffff:a9fe:a9fe', 'link-local'],
  ['::ffff:10.0.0.1', 'private'],
  ['::ffff:1.1.1.1', 'public'],
  // IPv4-translated (SIIT)
  ['::ffff:0:7f00:1', 'loopback'],
  ['::ffff:0:a9fe:a9fe', 'link-local'],
  // IPv4-compatible (deprecated)
  ['::127.0.0.1', 'loopback'],
  ['::7f00:1', 'loopback'],
  ['::169.254.169.254', 'link-local'],
  ['::a9fe:a9fe', 'link-local'],
  // NAT64 well-known prefix
  ['64:ff9b::7f00:1', 'loopback'],
  ['64:ff9b::127.0.0.1', 'loopback'],
  ['64:ff9b::a9fe:a9fe', 'link-local'],
  ['64:ff9b::101:101', 'public'],
  // 6to4: the IPv4 sits in bits 16–47
  ['2002:7f00:1::', 'loopback'],
  ['2002:a9fe:a9fe::1', 'link-local'],
  ['2002:c0a8:101::', 'private'],
  ['2002:101:101::1', 'public'],
]

function verdictOf(address: string): 'public' | AddressRefusal {
  const result = classifyAddress(address)
  return result.kind === 'public' ? 'public' : result.reason
}

describe('classifyAddress', () => {
  test.each(IPV4_ROWS)('IPv4 %s → %s', (address, expected) => {
    expect(verdictOf(address)).toBe(expected)
  })

  test.each(IPV6_ROWS)('IPv6 %s → %s', (address, expected) => {
    expect(verdictOf(address)).toBe(expected)
  })

  test.each(EMBEDDED_ROWS)('embedded IPv4 %s → %s', (address, expected) => {
    expect(verdictOf(address)).toBe(expected)
  })

  test('a refusal result carries its reason and nothing else', () => {
    expect(classifyAddress('10.1.2.3')).toEqual({ kind: 'refused', reason: 'private' })
    expect(classifyAddress('1.1.1.1')).toEqual({ kind: 'public' })
  })

  test('the result is frozen', () => {
    expect(Object.isFrozen(classifyAddress('127.0.0.1'))).toBe(true)
    expect(Object.isFrozen(classifyAddress('1.1.1.1'))).toBe(true)
  })

  test.each([
    '127.evil.com',
    'localhost',
    'example.com',
    '',
    '127.1',
    '0x7f000001',
    '2130706433',
    '010.0.0.1',
    '[::1]',
    ' 127.0.0.1',
    '1.1.1.1%eth0',
  ])('%j is not an IP address → throws (the caller must resolve first)', (input) => {
    expect(() => classifyAddress(input)).toThrow(TypeError)
  })
})
