import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Role } from '../../src/admin/authz.js'
import { PRODUCT_VERSION } from '../../src/brand.js'
import { runRemoteTui } from '../../src/cli/tui-remote.js'
import { plainStyle } from '../../src/tui/ansi.js'
import { SECTIONS, visibleSections } from '../../src/tui/catalogue/index.js'
import { ACTION_COLUMN_WIDTH, COLUMN_GAP, DEFAULT_COLUMNS } from '../../src/tui/constants.js'
import { initialModel, OWN_SUPERVISOR, type InstallFacts } from '../../src/tui/model.js'
import { createRemoteClient, type FetchLike, type RemoteIo } from '../../src/tui/remote/client.js'
import { parseRemoteUrl } from '../../src/tui/remote/url.js'
import { render } from '../../src/tui/render.js'
import { createFakeTerminal } from './support/fake-terminal.js'

/**
 * The console names the next step (owner's rule 2026-09-29): the first
 * screens after sign-in say how to fill an empty section — the action to
 * press, or, for a role that cannot, that an owner does it; the sign-in screen
 * says how to get a token back; and every way the console fails to reach its
 * service says what to do about it.
 */

beforeEach(() => {
  vi.stubEnv('npm_command', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const PANE_WIDTH = DEFAULT_COLUMNS - ACTION_COLUMN_WIDTH - COLUMN_GAP

function introOf(sectionId: string, role: Role): readonly string[] {
  const section = visibleSections(role).find((each) => each.id === sectionId)
  if (section === undefined) throw new Error(`no ${sectionId} section for ${role}`)
  return section.intro
}

describe('an empty section says how to fill it', () => {
  test('Home: an owner is pointed at the first two actions of a new install', () => {
    expect(introOf('home', 'owner').at(-1)).toBe('New here? Servers ▸ add, then Agents ▸ create.')
  })

  test('Servers: an owner is pointed at add; a viewer is told an owner registers them', () => {
    expect(introOf('servers', 'owner').at(-1)).toBe('None yet? add registers one.')
    expect(introOf('servers', 'viewer').at(-1)).toBe('None yet? An owner registers them.')
    expect(introOf('servers', 'operator').join('\n')).not.toContain('add registers')
  })

  test('Agents and Groups: create for an owner, the owner for anyone else', () => {
    expect(introOf('agents', 'owner').at(-1)).toBe('None yet? create one, then grant it a server.')
    expect(introOf('agents', 'viewer').at(-1)).toBe('None yet? An owner creates them.')
    expect(introOf('groups', 'owner').at(-1)).toBe('None yet? create one, then join agents to it.')
    expect(introOf('groups', 'operator').at(-1)).toBe('None yet? An owner creates them.')
  })

  test('Home under a role that cannot add names the owner instead', () => {
    expect(introOf('home', 'viewer').at(-1)).toBe('An owner adds the servers and agents.')
  })

  test('the next-step lines fit the pane beside the action column, and the catalogue is not changed', () => {
    for (const role of ['owner', 'operator', 'viewer'] as const) {
      for (const section of visibleSections(role)) {
        for (const line of section.intro) expect(line.length, `${section.id}: ${line}`).toBeLessThanOrEqual(PANE_WIDTH)
      }
    }
    const servers = SECTIONS.find((section) => section.id === 'servers')
    expect(servers?.intro.join('\n')).not.toContain('None yet?')
  })
})

const LOCAL: InstallFacts = { supervisor: OWN_SUPERVISOR }
const REMOTE: InstallFacts = { supervisor: OWN_SUPERVISOR, remote: true, remoteAddress: 'https://plane.example.com' }

function signinText(install: InstallFacts, columns = 80): string {
  return render(initialModel({ columns, rows: 24 }, install), plainStyle).join('\n')
}

describe('the sign-in screen says how to get a token back', () => {
  test('locally: the recover command on a line of its own, in the form this process was started', () => {
    const lines = signinText(LOCAL).split('\n').map((line) => line.trim())
    const at = lines.indexOf('Lost it? Esc, then run:')
    expect(at).toBeGreaterThan(0)
    expect(lines[at + 1]).toBe('mcpcut admin rotate <name> --recover')

    vi.stubEnv('npm_command', 'exec')
    expect(signinText(LOCAL)).toContain(`npx -y mcpcut@${PRODUCT_VERSION} admin rotate <name> --recover`)
  })

  test('over --remote: an owner reissues it from Admins, or the host recovers it', () => {
    const text = signinText(REMOTE)
    expect(text).toContain('Lost it? An owner reissues it: Admins ▸ rotate')
    expect(text).toContain('or on its host: mcpcut admin rotate <name> --recover')
  })

  test('the hint keeps the block centred: the title stays in the middle of an 80-column screen under npx', () => {
    vi.stubEnv('npm_command', 'exec')
    const title = signinText(LOCAL).split('\n').find((line) => line.trim() === 'Sign in') ?? ''
    // The block is centred on its widest line; the old one-line npx hint (≈ 80 wide) pinned it to the left edge.
    expect(title.indexOf('Sign in')).toBeGreaterThanOrEqual(10)
  })

  test('a narrow terminal keeps every row inside the screen and the whole command on screen', () => {
    vi.stubEnv('npm_command', 'exec')
    const rows = signinText(LOCAL, 40).split('\n')
    expect(rows.every((row) => row.length <= 40)).toBe(true)
    expect(rows.join(' ').replace(/\s+/g, ' ')).toContain('admin rotate <name> --recover')
  })
})

function silentIo(): { io: { stdout: { write: (c: string) => boolean }; stderr: { write: (c: string) => boolean } }; err: () => string } {
  const errChunks: string[] = []
  return {
    io: { stdout: { write: () => true }, stderr: { write: (chunk: string) => errChunks.push(chunk) > 0 } },
    err: () => errChunks.join(''),
  }
}

const refusingFetch = (async () => {
  throw new Error('ECONNREFUSED')
}) as FetchLike

describe('a console that cannot reach its service says what to do', () => {
  test('--remote to an address that does not answer: check it, or connect to another', async () => {
    const { io, err } = silentIo()
    const fake = createFakeTerminal()

    const code = await runRemoteTui(parseRemoteUrl('https://plane.example.com:8091'), io, {}, {
      terminal: fake.terminal,
      style: plainStyle,
      processEvents: new EventEmitter(),
      escapeCodeTimeoutMs: 10,
      platform: 'linux',
      remoteFetch: refusingFetch,
    })

    expect(code).toBe(1)
    const lines = err().trimEnd().split('\n')
    expect(lines[0]).toContain('could not open the console')
    expect(lines.at(-1)).toBe(
      'Check that mcpcut ui runs at https://plane.example.com:8091, or connect to another: ' +
        'mcpcut --connect https://plane.example.com:8091',
    )
  })

  test('a run that cannot reach the service says to check it and run the action again', async () => {
    const client = createRemoteClient({ baseUrl: 'https://plane.example.com', fetchImpl: refusingFetch })
    const errChunks: string[] = []
    const io: RemoteIo = { stdout: { write: () => true }, stderr: { write: (chunk: string) => errChunks.push(chunk) > 0 } }

    await client.run({ argv: ['status'] }, 'tok', io)

    const line = errChunks.join('').trimEnd()
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('could not reach the remote console')
    expect(line).toContain('check that it runs at https://plane.example.com, then run the action again')
  })

  test('an answer with no readable reason gets the same next step', async () => {
    const fetchImpl = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as FetchLike
    const client = createRemoteClient({ baseUrl: 'https://plane.example.com', fetchImpl })
    const errChunks: string[] = []
    const io: RemoteIo = { stdout: { write: () => true }, stderr: { write: (chunk: string) => errChunks.push(chunk) > 0 } }

    await client.run({ argv: ['status'] }, 'tok', io)

    expect(errChunks.join('')).toContain('HTTP 502')
    expect(errChunks.join('')).toContain('then run the action again')
  })
})
