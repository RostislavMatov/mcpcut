import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { DEFAULT_SERVE_PORT } from '../../src/cli/serve-constants.js'
import { CONFIG_PATH_ENV_VAR, INSTALL_CONFIG_VERSION, SERVE_PORT_ENV_VAR } from '../../src/setup/constants.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import type { InstallConfig } from '../../src/setup/schema.js'
import {
  addressNoteOf,
  resolveServeAddress,
  SERVE_URL_PLACEHOLDER,
  serveAddressFromInstall,
  serveAddressOf,
} from '../../src/setup/serve-address.js'

/**
 * The address `agent create` writes into a client config as `--url` (ADR-0015,
 * phase 4, C2): the remembered `serve.publicUrl` when the install names one;
 * otherwise the loopback form of the bind — right on the machine the plane
 * runs on, the first-run case of the owner's frame; a placeholder only when
 * no address could be dialled at all.
 */

const ABSENT: InstallConfigLoad = { kind: 'absent', path: '/home/op/.mcpcut/config.json' }

function loadWithServe(serve: InstallConfig['serve']): InstallConfigLoad {
  return {
    kind: 'ok',
    path: '/home/op/.mcpcut/config.json',
    config: {
      version: INSTALL_CONFIG_VERSION,
      dataDir: '/var/lib/mcpcut',
      ui: { host: '127.0.0.1', port: 8091 },
      serve,
    },
  }
}

describe('serveAddressOf', () => {
  test('the remembered public address wins and is marked as coming from the config', () => {
    expect(serveAddressOf({ port: 8090, publicUrl: 'https://mcp.example.com' })).toEqual({
      url: 'https://mcp.example.com',
      source: 'config',
    })
  })

  test('without one, the loopback form of the bind port is derived', () => {
    expect(serveAddressOf({ port: 9000 })).toEqual({ url: 'http://127.0.0.1:9000', source: 'derived' })
  })

  test('port 0 ("any free port") cannot be dialled: the placeholder, never a guess that looks real', () => {
    expect(serveAddressOf({ port: 0 })).toEqual({ url: SERVE_URL_PLACEHOLDER, source: 'unknown' })
  })

  test('returns a new value on every call', () => {
    expect(serveAddressOf({ port: 9000 })).not.toBe(serveAddressOf({ port: 9000 }))
  })
})

describe('serveAddressFromInstall', () => {
  test('no config and no env: the documented default port on loopback', () => {
    expect(serveAddressFromInstall({}, ABSENT)).toEqual({
      url: `http://127.0.0.1:${DEFAULT_SERVE_PORT}`,
      source: 'derived',
    })
  })

  test('the env port outranks the config port in the derived address, as it does for the bind', () => {
    const load = loadWithServe({ host: '127.0.0.1', port: 9090 })

    expect(serveAddressFromInstall({ [SERVE_PORT_ENV_VAR]: '9000' }, load).url).toBe('http://127.0.0.1:9000')
  })

  test('the config public address wins over the bind', () => {
    const load = loadWithServe({ host: '0.0.0.0', port: 9090, publicUrl: 'http://203.0.113.7:8090' })

    expect(serveAddressFromInstall({}, load)).toEqual({ url: 'http://203.0.113.7:8090', source: 'config' })
  })

  test('any other fault is not disguised as an unknown address', () => {
    const broken = {
      kind: 'ok',
      path: '/home/op/.mcpcut/config.json',
      get config(): never {
        throw new Error('disk on fire')
      },
    } as unknown as InstallConfigLoad

    expect(() => serveAddressFromInstall({}, broken)).toThrow('disk on fire')
  })

  test('an unusable MCPCUT_SERVE_PORT means "unknown", not a crash: printing a config is not starting serve', () => {
    expect(serveAddressFromInstall({ [SERVE_PORT_ENV_VAR]: '8O90' }, ABSENT)).toEqual({
      url: SERVE_URL_PLACEHOLDER,
      source: 'unknown',
    })
  })
})

describe('addressNoteOf', () => {
  test('a remembered address needs no note', () => {
    expect(addressNoteOf({ url: 'https://h', source: 'config' })).toBeUndefined()
  })

  test('a derived address says it only works here and how to fix that', () => {
    expect(addressNoteOf({ url: 'http://127.0.0.1:8090', source: 'derived' })).toBe(
      'note: address derived from the serve bind; for agents on other machines run: mcpcut setup --serve-public-url <url>',
    )
  })

  test('an unknown address names the placeholder to replace and the variable at fault', () => {
    const note = addressNoteOf({ url: SERVE_URL_PLACEHOLDER, source: 'unknown' })

    expect(note).toContain('replace <serve-url>')
    expect(note).toContain(SERVE_PORT_ENV_VAR)
  })
})

describe('resolveServeAddress', () => {
  test('reads serve.publicUrl from the install config the environment names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpcut-serve-address-'))
    try {
      const path = join(dir, 'config.json')
      writeFileSync(
        path,
        JSON.stringify({
          version: INSTALL_CONFIG_VERSION,
          dataDir: '/var/lib/mcpcut',
          ui: { host: '127.0.0.1', port: 8091 },
          serve: { host: '127.0.0.1', port: 8090, publicUrl: 'https://plane.example' },
        }),
      )

      expect(resolveServeAddress({ env: { [CONFIG_PATH_ENV_VAR]: path } })).toEqual({
        url: 'https://plane.example',
        source: 'config',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an injected install config wins over the file', () => {
    expect(resolveServeAddress({ env: {}, install: ABSENT })).toEqual({
      url: `http://127.0.0.1:${DEFAULT_SERVE_PORT}`,
      source: 'derived',
    })
  })
})
