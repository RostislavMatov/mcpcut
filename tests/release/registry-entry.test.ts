import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * `server.json` is the package's entry in the official MCP Registry
 * (`mcp-publisher publish`). The registry checks it against what npm holds: the
 * name must be the `mcpName` of the published `package.json`, and the package
 * version must exist on npm. An entry left behind at the next bump would send
 * registry clients to an older release, so it moves with the version.
 */

const PROJECT_ROOT = process.cwd()

/** The registry's own limit; `mcp-publisher publish` refuses a longer one. */
const DESCRIPTION_MAX_LENGTH = 100

interface Manifest {
  readonly name: string
  readonly version: string
  readonly mcpName: string
}

interface Argument {
  readonly type: 'positional' | 'named'
  readonly value?: string
  readonly valueHint?: string
  readonly isRequired?: boolean
}

interface RegistryEntry {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly packages: readonly {
    readonly registryType: string
    readonly identifier: string
    readonly version: string
    readonly transport: { readonly type: string }
    readonly packageArguments: readonly Argument[]
  }[]
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, file), 'utf8')) as T
}

describe('the MCP Registry entry', () => {
  const manifest = readJson<Manifest>('package.json')
  const entry = readJson<RegistryEntry>('server.json')

  test('is named by the mcpName the npm package declares', () => {
    expect(entry.name).toBe(manifest.mcpName)
  })

  test('names the package version, at the top and on the npm package', () => {
    expect(entry.version).toBe(manifest.version)
    expect(entry.packages).toHaveLength(1)
    expect(entry.packages[0]).toMatchObject({
      registryType: 'npm',
      identifier: manifest.name,
      version: manifest.version,
      transport: { type: 'stdio' },
    })
  })

  test('fits the registry description limit', () => {
    expect(entry.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH)
  })

  test('runs `wrap -- <server command>`, the command a client starts', () => {
    // mcpcut alone is not an MCP server; a client that starts it without
    // `wrap` and a server command gets a usage error instead of tools.
    const args = entry.packages[0]?.packageArguments ?? []
    const separator = args.findIndex((arg) => arg.type === 'positional' && arg.value === '--')

    expect(args[0]).toEqual({ type: 'positional', value: 'wrap' })
    expect(separator).toBeGreaterThan(0)
    expect(args[separator + 1]).toMatchObject({ type: 'positional', isRequired: true })
    expect(args[separator + 1]?.value).toBeUndefined()
  })

  test('leaves no flag a client could emit without its value', () => {
    // `wrap` parses its flags strictly: `wrap --server -- npx …`, from a client
    // that writes an optional flag left blank, is a usage error, not a server.
    const args = entry.packages[0]?.packageArguments ?? []
    const blankable = args.filter((arg) => arg.type === 'named' && arg.isRequired !== true && arg.value === undefined)

    expect(blankable).toEqual([])
  })
})
