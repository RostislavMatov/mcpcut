import { join } from 'node:path'

/**
 * Where `mcpcut adopt` (P3) looks for MCP servers: each client, each scope,
 * as a file and the path inside it to the `mcpServers` object. Pure — the
 * home folder, working folder and platform come in — so tests pin every
 * platform from one machine.
 */

export type ClientId = 'claude-code' | 'cursor' | 'claude-desktop'

export const CLIENT_IDS: readonly ClientId[] = ['claude-code', 'cursor', 'claude-desktop']

export const CLIENT_LABELS: Readonly<Record<ClientId, string>> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  'claude-desktop': 'Claude Desktop',
}

export interface ServersLocation {
  readonly client: ClientId
  /** Which of the client's scopes, as the client's own docs name it. */
  readonly scope: string
  readonly file: string
  /** Keys from the document root to the object of servers. */
  readonly path: readonly string[]
}

export interface AdoptPlace {
  readonly home: string
  readonly cwd: string
  readonly platform: NodeJS.Platform
  /** `%APPDATA%` on Windows; defaults to `<home>/AppData/Roaming`. */
  readonly appData?: string
}

const SERVERS_KEY = 'mcpServers'

function claudeDesktopFile(place: AdoptPlace): string {
  const name = join('Claude', 'claude_desktop_config.json')
  if (place.platform === 'darwin') return join(place.home, 'Library', 'Application Support', name)
  if (place.platform === 'win32') return join(place.appData ?? join(place.home, 'AppData', 'Roaming'), name)
  return join(place.home, '.config', name)
}

/**
 * How `~/.claude.json` may key this folder under `projects`: the path as the
 * OS gives it, and on Windows also with forward slashes (the form Claude Code
 * is believed to write there; whichever holds servers is found, and the
 * dedupe below keeps one when both spell the same).
 */
function projectKeysOf(place: AdoptPlace): readonly string[] {
  return place.platform === 'win32' ? [place.cwd, place.cwd.replaceAll('\\', '/')] : [place.cwd]
}

function allLocations(place: AdoptPlace): readonly ServersLocation[] {
  const claudeJson = join(place.home, '.claude.json')
  return [
    { client: 'claude-code', scope: 'user', file: claudeJson, path: [SERVERS_KEY] },
    ...projectKeysOf(place).map((key) => ({ client: 'claude-code' as const, scope: 'local, this folder', file: claudeJson, path: ['projects', key, SERVERS_KEY] })),
    { client: 'claude-code', scope: 'project, shared through .mcp.json', file: join(place.cwd, '.mcp.json'), path: [SERVERS_KEY] },
    { client: 'cursor', scope: 'global', file: join(place.home, '.cursor', 'mcp.json'), path: [SERVERS_KEY] },
    { client: 'cursor', scope: 'this project', file: join(place.cwd, '.cursor', 'mcp.json'), path: [SERVERS_KEY] },
    { client: 'claude-desktop', scope: 'app', file: claudeDesktopFile(place), path: [SERVERS_KEY] },
  ]
}

function keyOf(location: ServersLocation): string {
  return JSON.stringify([location.file, ...location.path])
}

/** Every place, once: run from the home folder, a project file is the global one. */
export function locationsOf(place: AdoptPlace): readonly ServersLocation[] {
  const seen = new Set<string>()
  return allLocations(place).filter((location) => {
    const key = keyOf(location)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
