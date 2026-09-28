import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

/**
 * `docs/deploy/site/tenant-firewall.sh` (fix `tenant-network-isolation`): the
 * host-side rules that keep a tenant's Docker bridge (`mct+`,
 * `hub/src/provisioner/templates.ts`) from reaching the host's own services
 * (SSH, a VPN on 443, ...) or another private range, found reachable by a
 * live smoke on S2.
 *
 * Tested the way `tests/docker/entrypoint.test.ts` tests shell: fake
 * `iptables`/`ip6tables` earlier on `PATH` that keep a small in-memory
 * ruleset per chain (one file per `<binary>.<chain>`, one rule spec per
 * line, in order) and support exactly the four sub-commands the script
 * issues (`-N`, `-D`, `-I <pos>`, `-A`) — enough to make "idempotent" and
 * "this rule sits above that one" checkable without a real netfilter table.
 */

const SCRIPT = join(process.cwd(), 'docs', 'deploy', 'site', 'tenant-firewall.sh')
const FAKE_MODE = 0o755
const COMMENT = 'mcpcut-tenant'

const INPUT_ACCEPT = `-i mct+ -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment ${COMMENT} -j ACCEPT`
const INPUT_DROP = `-i mct+ -m comment --comment ${COMMENT} -j DROP`
const DU_ESTABLISHED = `-i mct+ -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment ${COMMENT} -j RETURN`
const DU_CADDY = `-i mct+ -o mct+ -p tcp -m multiport --dports 8090,8091 -m comment --comment ${COMMENT} -j RETURN`
const DU_DROP = (range: string) => `-i mct+ -d ${range} -m comment --comment ${COMMENT} -j DROP`
const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16']

let workDir: string
let binDir: string
let stateDir: string
let logPath: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mcpcut-firewall-'))
  binDir = join(workDir, 'bin')
  stateDir = join(workDir, 'state')
  logPath = join(workDir, 'calls.log')
  await mkdir(stateDir, { recursive: true })
  await mkdir(binDir, { recursive: true })
  await writeFakeIptables('iptables')
  await writeFakeIptables('ip6tables')
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

/**
 * A fake `iptables`/`ip6tables`: one rule-spec-per-line file per chain
 * (`$FAKE_STATE_DIR/<binary-name>.<chain>.rules`), supporting only the
 * sub-commands `tenant-firewall.sh` issues. `-D` deletes the first line that
 * matches the given spec exactly (real iptables' rule-spec delete), `-I
 * <chain> <pos>` inserts at a 1-based position, `-N` creates an empty chain
 * (and fails, like the real thing, if it already exists), `-A` appends.
 * Every invocation is also logged as one line (`<binary> <args>`), so a test
 * can check the exact commands issued, not just their end state.
 */
async function writeFakeIptables(name: 'iptables' | 'ip6tables'): Promise<void> {
  const path = join(binDir, name)
  const script = [
    '#!/bin/sh',
    'set -eu',
    'BIN=$(basename "$0")',
    'printf \'%s %s\\n\' "$BIN" "$*" >> "$FAKE_LOG"',
    'chain_file() { printf \'%s/%s.%s.rules\' "$FAKE_STATE_DIR" "$BIN" "$1"; }',
    'case "$1" in',
    '  -N)',
    '    f="$(chain_file "$2")"',
    '    if [ -e "$f" ]; then echo "iptables: Chain already exists." >&2; exit 1; fi',
    '    : > "$f"',
    '    ;;',
    '  -D)',
    '    chain="$2"; shift 2; spec="$*"',
    '    f="$(chain_file "$chain")"',
    '    [ -e "$f" ] || exit 1',
    '    grep -qxF -- "$spec" "$f" 2>/dev/null || exit 1',
    '    tmp="$f.tmp.$$"',
    '    awk -v s="$spec" \'BEGIN{done=0} { if (!done && $0==s) { done=1; next } print }\' "$f" > "$tmp"',
    '    mv "$tmp" "$f"',
    '    ;;',
    '  -I)',
    '    chain="$2"; pos="$3"; shift 3; spec="$*"',
    '    f="$(chain_file "$chain")"',
    '    [ -e "$f" ] || : > "$f"',
    '    tmp="$f.tmp.$$"',
    '    awk -v s="$spec" -v p="$pos" \'',
    '      BEGIN{n=0}',
    '      { n++; if (n==p) print s; print }',
    '      END{ if (p>n) print s }',
    '    \' "$f" > "$tmp"',
    '    mv "$tmp" "$f"',
    '    ;;',
    '  -A)',
    '    chain="$2"; shift 2; spec="$*"',
    '    f="$(chain_file "$chain")"',
    '    [ -e "$f" ] || : > "$f"',
    '    printf \'%s\\n\' "$spec" >> "$f"',
    '    ;;',
    '  *)',
    '    echo "fake $BIN: unsupported invocation: $*" >&2',
    '    exit 2',
    '    ;;',
    'esac',
    '',
  ].join('\n')
  await writeFile(path, script, 'utf8')
  await chmod(path, FAKE_MODE)
}

function runScript(extraEnv: Readonly<Record<string, string>> = {}): { readonly status: number | null; readonly stderr: string } {
  const result = spawnSync(SCRIPT, [], {
    encoding: 'utf8',
    env: { PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`, FAKE_LOG: logPath, FAKE_STATE_DIR: stateDir, ...extraEnv },
  })
  return { status: result.status, stderr: result.stderr }
}

async function chainRules(binary: 'iptables' | 'ip6tables', chain: string): Promise<readonly string[]> {
  try {
    const content = await readFile(join(stateDir, `${binary}.${chain}.rules`), 'utf8')
    return content.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

describe.skipIf(process.platform === 'win32')('docs/deploy/site/tenant-firewall.sh', () => {
  test('adds the INPUT rules with the established-ACCEPT above the DROP', async () => {
    const { status, stderr } = runScript()

    expect(status).toBe(0)
    expect(stderr).toContain('rules applied')
    expect(await chainRules('iptables', 'INPUT')).toEqual([INPUT_ACCEPT, INPUT_DROP])
  })

  test('creates DOCKER-USER and adds established-RETURN, then Caddy RETURN, then a DROP per private range', async () => {
    runScript()

    expect(await chainRules('iptables', 'DOCKER-USER')).toEqual([DU_ESTABLISHED, DU_CADDY, ...PRIVATE_RANGES.map(DU_DROP)])
  })

  test('adds the ip6tables INPUT analogue in the same order', async () => {
    runScript()

    expect(await chainRules('ip6tables', 'INPUT')).toEqual([INPUT_ACCEPT, INPUT_DROP])
  })

  test('running twice leaves the exact same rules, not duplicates', async () => {
    runScript()
    const { status, stderr } = runScript()

    expect(status).toBe(0)
    expect(stderr).toContain('rules applied')
    expect(await chainRules('iptables', 'INPUT')).toEqual([INPUT_ACCEPT, INPUT_DROP])
    expect(await chainRules('iptables', 'DOCKER-USER')).toEqual([DU_ESTABLISHED, DU_CADDY, ...PRIVATE_RANGES.map(DU_DROP)])
    expect(await chainRules('ip6tables', 'INPUT')).toEqual([INPUT_ACCEPT, INPUT_DROP])
  })

  test('running twice deletes its own rules before re-adding them (not appending on top)', async () => {
    runScript()
    await rm(logPath)
    runScript()
    const secondLog = await readFile(logPath, 'utf8')
    const deleteLine = `iptables -D INPUT ${INPUT_DROP}`
    const insertLine = `iptables -I INPUT 2 ${INPUT_DROP}`

    // The second run must attempt to delete its own INPUT DROP rule BEFORE
    // adding it again — proof it removes-then-adds rather than only
    // appending (which "running twice leaves the exact same rules" already
    // shows the end result of, but not the order of operations that got
    // there).
    expect(secondLog).toContain(deleteLine)
    expect(secondLog.indexOf(deleteLine)).toBeLessThan(secondLog.indexOf(insertLine))
  })

  test('an unrelated pre-existing INPUT rule is left in place, below the two new ones', async () => {
    await writeFile(
      join(stateDir, 'iptables.INPUT.rules'),
      '-p tcp --dport 22 -j ACCEPT\n',
      'utf8',
    )

    runScript()

    expect(await chainRules('iptables', 'INPUT')).toEqual([INPUT_ACCEPT, INPUT_DROP, '-p tcp --dport 22 -j ACCEPT'])
  })

  test('a pre-existing DOCKER-USER default rule stays below the new ones', async () => {
    await writeFile(join(stateDir, 'iptables.DOCKER-USER.rules'), '-j RETURN\n', 'utf8')

    runScript()

    expect(await chainRules('iptables', 'DOCKER-USER')).toEqual([
      DU_ESTABLISHED,
      DU_CADDY,
      ...PRIVATE_RANGES.map(DU_DROP),
      '-j RETURN',
    ])
  })

  test('missing ip6tables on PATH does not fail the script', async () => {
    // Only `iptables` on PATH; the fake `ip6tables` written in beforeEach is
    // simply not referenced (a fresh, ip6tables-less PATH is built here).
    const ipv4OnlyBin = join(workDir, 'bin-v4-only')
    await mkdir(ipv4OnlyBin, { recursive: true })
    const iptablesPath = join(binDir, 'iptables')
    const content = await readFile(iptablesPath, 'utf8')
    await writeFile(join(ipv4OnlyBin, 'iptables'), content, 'utf8')
    await chmod(join(ipv4OnlyBin, 'iptables'), FAKE_MODE)

    const result = spawnSync(SCRIPT, [], {
      encoding: 'utf8',
      env: { PATH: `${ipv4OnlyBin}${delimiter}/usr/bin:/bin`, FAKE_LOG: logPath, FAKE_STATE_DIR: stateDir },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('ip6tables not found')
    expect(await chainRules('iptables', 'INPUT')).toEqual([INPUT_ACCEPT, INPUT_DROP])
  })

  test('the script is POSIX shell: dash runs it too', () => {
    const found = spawnSync('/bin/sh', ['-c', 'command -v dash'], { encoding: 'utf8' })
    const dash = found.status === 0 ? found.stdout.trim() : undefined
    if (dash === undefined) return

    const result = spawnSync(dash, [SCRIPT], {
      encoding: 'utf8',
      env: { PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`, FAKE_LOG: logPath, FAKE_STATE_DIR: stateDir },
    })

    expect(result.stderr).toContain('rules applied')
    expect(result.status).toBe(0)
  })
})
