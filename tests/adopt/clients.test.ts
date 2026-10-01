import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { locationsOf } from '../../src/adopt/clients.js'

/** Where `mcpcut adopt` looks: every place Claude Code, Cursor and Claude Desktop keep MCP servers. */

const HOME = '/home/me'
const CWD = '/home/me/work/app'

function placesOf(platform: NodeJS.Platform, extra: { appData?: string; cwd?: string } = {}): string[] {
  return locationsOf({ home: HOME, cwd: extra.cwd ?? CWD, platform, appData: extra.appData }).map(
    (location) => `${location.client} ${location.file} ${location.path.join('/')}`,
  )
}

describe('locationsOf', () => {
  test('Claude Code: user and local scopes in ~/.claude.json, project scope in ./.mcp.json', () => {
    const places = placesOf('linux')

    expect(places).toContain(`claude-code ${join(HOME, '.claude.json')} mcpServers`)
    expect(places).toContain(`claude-code ${join(HOME, '.claude.json')} projects/${CWD}/mcpServers`)
    expect(places).toContain(`claude-code ${join(CWD, '.mcp.json')} mcpServers`)
  })

  test('Cursor: global ~/.cursor/mcp.json and this project ./.cursor/mcp.json', () => {
    const places = placesOf('darwin')

    expect(places).toContain(`cursor ${join(HOME, '.cursor', 'mcp.json')} mcpServers`)
    expect(places).toContain(`cursor ${join(CWD, '.cursor', 'mcp.json')} mcpServers`)
  })

  test.each([
    ['darwin', {}, join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')],
    ['win32', { appData: 'C:/Users/me/AppData/Roaming' }, join('C:/Users/me/AppData/Roaming', 'Claude', 'claude_desktop_config.json')],
    ['win32', {}, join(HOME, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')],
    ['linux', {}, join(HOME, '.config', 'Claude', 'claude_desktop_config.json')],
  ] as const)('Claude Desktop on %s', (platform, extra, file) => {
    expect(placesOf(platform, extra)).toContain(`claude-desktop ${file} mcpServers`)
  })

  test('run from the home folder, the project files are the global ones: each place is listed once', () => {
    const places = placesOf('darwin', { cwd: HOME })

    expect(places.filter((place) => place.startsWith('cursor ')).length).toBe(1)
    expect(new Set(places).size).toBe(places.length)
  })

  test('the project .mcp.json is marked as shared, since teams commit it', () => {
    const project = locationsOf({ home: HOME, cwd: CWD, platform: 'linux' }).find((location) => location.file === join(CWD, '.mcp.json'))

    expect(project?.scope).toMatch(/shared/)
  })
})
