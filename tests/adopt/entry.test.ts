import { describe, expect, test } from 'vitest'
import { adoptEntry, launcherOf } from '../../src/adopt/entry.js'

/**
 * `mcpcut adopt` (P3): one server entry of a client's config in, a verdict
 * out. Pure — the file IO lives elsewhere — so every shape a real config
 * holds is pinned here.
 */

const VERSION = '9.9.9'
const POSIX = launcherOf(VERSION, 'darwin')
const WINDOWS = launcherOf(VERSION, 'win32')

describe('launcherOf', () => {
  test('starts the pinned package through npx', () => {
    expect(POSIX).toEqual({ command: 'npx', args: ['-y', 'mcpcut@9.9.9'] })
  })

  test('on Windows goes through cmd /c, as npm commands there are .cmd shims', () => {
    expect(WINDOWS).toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', 'mcpcut@9.9.9'] })
  })
})

describe('adoptEntry: a stdio server is wrapped', () => {
  test('the server command moves after "--" and the config key names the server', () => {
    const entry = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/me/project'] }

    const verdict = adoptEntry('fs', entry, POSIX, 'darwin')

    expect(verdict).toEqual({
      kind: 'wrap',
      next: {
        command: 'npx',
        args: ['-y', 'mcpcut@9.9.9', 'wrap', '--server', 'fs', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '/home/me/project'],
      },
    })
  })

  test('every other field (env, type, cwd, unknown keys) is kept as it was', () => {
    const entry = { type: 'stdio', command: 'uvx', args: ['mcp-server-git'], env: { GITHUB_TOKEN: 'x' }, cwd: '/w', note: 1 }

    const verdict = adoptEntry('git', entry, POSIX, 'linux')

    expect(verdict.kind).toBe('wrap')
    expect(verdict.kind === 'wrap' && verdict.next).toMatchObject({ type: 'stdio', env: { GITHUB_TOKEN: 'x' }, cwd: '/w', note: 1 })
  })

  test('an entry without args wraps the bare command', () => {
    const verdict = adoptEntry('mem', { command: '/usr/local/bin/memory-server' }, POSIX, 'darwin')

    expect(verdict.kind === 'wrap' && verdict.next['args']).toEqual(['-y', 'mcpcut@9.9.9', 'wrap', '--server', 'mem', '--', '/usr/local/bin/memory-server'])
  })

  test('the original entry is not mutated', () => {
    const entry = { command: 'npx', args: ['-y', 'some-server'] }
    const snapshot = structuredClone(entry)

    adoptEntry('s', entry, POSIX, 'darwin')

    expect(entry).toEqual(snapshot)
  })
})

describe('adoptEntry: Windows', () => {
  test('an npm shim gets "cmd /c" after "--" too', () => {
    const verdict = adoptEntry('fs', { command: 'npx', args: ['-y', 'pkg'] }, WINDOWS, 'win32')

    expect(verdict.kind === 'wrap' && verdict.next).toMatchObject({
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'mcpcut@9.9.9', 'wrap', '--server', 'fs', '--', 'cmd', '/c', 'npx', '-y', 'pkg'],
    })
  })

  test('a server already started through cmd is not given a second cmd /c', () => {
    const verdict = adoptEntry('fs', { command: 'cmd', args: ['/c', 'npx', '-y', 'pkg'] }, WINDOWS, 'win32')

    expect(verdict.kind === 'wrap' && verdict.next['args']).toEqual(['/c', 'npx', '-y', 'mcpcut@9.9.9', 'wrap', '--server', 'fs', '--', 'cmd', '/c', 'npx', '-y', 'pkg'])
  })

  test.each([
    ['an & in an argument', 'pg', { command: 'uvx', args: ['postgres-mcp', 'postgresql://h/db?a=1&b=2'] }],
    ['a % in an argument', 'x', { command: 'node', args: ['s.js', '%PATH%'] }],
    ['a quote in an argument', 'x', { command: 'node', args: ['s.js', 'say "hi"'] }],
    ['a | in the name', 'a|b', { command: 'node', args: ['s.js'] }],
  ])('%s is left for the user: cmd /c would read it as syntax', (_label, name, entry) => {
    expect(adoptEntry(name, entry, WINDOWS, 'win32')).toEqual({ kind: 'cmd-unsafe' })
  })

  test('the same characters are plain text elsewhere: no shell is involved', () => {
    const verdict = adoptEntry('pg', { command: 'uvx', args: ['postgresql://h/db?a=1&b=2'] }, POSIX, 'linux')

    expect(verdict.kind).toBe('wrap')
  })

  test('a .cmd script gets cmd /c; an .exe does not', () => {
    const script = adoptEntry('a', { command: 'C:\\tools\\server.CMD' }, WINDOWS, 'win32')
    const binary = adoptEntry('b', { command: 'C:\\tools\\server.exe' }, WINDOWS, 'win32')

    expect(script.kind === 'wrap' && script.next['args']).toContain('/c')
    expect(script.kind === 'wrap' && (script.next['args'] as string[]).slice(-3)).toEqual(['cmd', '/c', 'C:\\tools\\server.CMD'])
    expect(binary.kind === 'wrap' && (binary.next['args'] as string[]).slice(-1)).toEqual(['C:\\tools\\server.exe'])
  })
})

describe('adoptEntry: entries left alone', () => {
  test.each([
    ['npx mcpcut@<version> wrap', { command: 'npx', args: ['-y', 'mcpcut@0.2.4', 'wrap', '--server', 'fs', '--', 'npx', 'x'] }],
    ['bare mcpcut wrap', { command: 'mcpcut', args: ['wrap', '--', 'node', 's.js'] }],
    ['the connect bridge', { command: 'npx', args: ['-y', 'mcpcut@0.2.4', 'connect', '--url', 'https://h'] }],
    ['cmd /c npx mcpcut', { command: 'cmd', args: ['/c', 'npx', '-y', 'mcpcut@0.2.4', 'wrap', '--', 'x'] }],
    ['an installed mcpcut by path', { command: '/opt/bin/mcpcut.cmd', args: ['wrap', '--', 'x'] }],
  ])('%s is already behind mcpcut', (_label, entry) => {
    expect(adoptEntry('s', entry, POSIX, 'darwin')).toEqual({ kind: 'already' })
  })

  test('a package merely named like mcpcut is not mistaken for it', () => {
    const verdict = adoptEntry('s', { command: 'npx', args: ['-y', 'mcpcut-themes'] }, POSIX, 'darwin')

    expect(verdict.kind).toBe('wrap')
  })

  test.each([
    ['url', { url: 'https://mcp.example.com/mcp' }],
    ['type http', { type: 'http', url: 'https://x' }],
    ['type sse', { type: 'sse', url: 'https://x/sse' }],
    ['serverUrl', { serverUrl: 'https://x' }],
  ])('a remote server (%s) is skipped', (_label, entry) => {
    expect(adoptEntry('r', entry, POSIX, 'darwin')).toEqual({ kind: 'remote' })
  })

  test.each([
    ['not an object', 'npx x'],
    ['no command', { args: ['x'] }],
    ['an empty command', { command: '  ' }],
    ['args not a list of strings', { command: 'npx', args: ['x', 1] }],
  ])('an entry with %s is reported, not touched', (_label, entry) => {
    expect(adoptEntry('bad', entry, POSIX, 'darwin').kind).toBe('unreadable')
  })
})
