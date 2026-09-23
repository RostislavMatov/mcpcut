import { describe, expect, test } from 'vitest'
import {
  CLIENT_CONFIG_ENTRY_NAME,
  CLIENT_CONFIG_LAUNCHER,
  clientConfigOf,
  needsAllowHttp,
  NPX_COMMAND,
  renderClientConfig,
  TOKEN_PLACEHOLDER,
} from '../../src/agents/client-config.js'
import { PRODUCT_VERSION } from '../../src/brand.js'
import { checkBridgeScheme, parseBridgeUrl } from '../../src/bridge/url.js'
import { SERVE_URL_PLACEHOLDER } from '../../src/setup/serve-address.js'

/**
 * The client config block (ADR-0015, phase 4): one pure function every
 * surface — CLI, web, console — prints, so the block an owner pastes is the
 * same bytes wherever the token was minted. Two rules are pinned against the
 * code that enforces them rather than restated: `--allow-http` against the
 * bridge's own verdict (PE8), the path of the HTTP form against the pool path.
 */

const TOKEN = 'mcpj_0123456789abcdef'

interface StdioShape {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

interface HttpShape {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

function stdioEntry(serveUrl: string, launcher?: 'binary' | 'npx'): StdioShape {
  return clientConfigOf({ serveUrl, token: TOKEN, form: 'stdio', ...(launcher ? { launcher } : {}) }).mcpServers[
    CLIENT_CONFIG_ENTRY_NAME
  ] as StdioShape
}

function httpEntry(serveUrl: string, token = TOKEN): HttpShape {
  return clientConfigOf({ serveUrl, token, form: 'http' }).mcpServers[CLIENT_CONFIG_ENTRY_NAME] as HttpShape
}

describe('renderClientConfig: the exact bytes', () => {
  test('stdio form, binary launcher, https address', () => {
    // A literal rather than a snapshot file: this text is what the README
    // shows and what an owner pastes, so a change to it should be a visible
    // change to this test.
    expect(
      renderClientConfig({ serveUrl: 'https://plane.example:8090', token: TOKEN, form: 'stdio', launcher: 'binary' }),
    ).toBe(
      [
        '{',
        '  "mcpServers": {',
        '    "mcpcut": {',
        '      "command": "mcpcut",',
        '      "args": [',
        '        "connect",',
        '        "--url",',
        '        "https://plane.example:8090"',
        '      ],',
        '      "env": {',
        `        "MCP_AGENT_TOKEN": "${TOKEN}"`,
        '      }',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
  })

  test('ends with exactly one newline and carries no TAB (the console pane renders TAB as ?)', () => {
    const text = renderClientConfig({ serveUrl: 'https://h', token: TOKEN, form: 'http' })

    expect(text.endsWith('}\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
    expect(text).not.toContain('\t')
  })

  test('is valid JSON that parses back to the document', () => {
    const input = { serveUrl: 'http://203.0.113.7:8090', token: TOKEN, form: 'stdio' } as const

    expect(JSON.parse(renderClientConfig(input))).toEqual(clientConfigOf(input))
  })
})

describe('clientConfigOf: the stdio form', () => {
  test('phase 4 launches the installed binary (PE10) and the token rides in env, never argv', () => {
    const entry = stdioEntry('https://plane.example:8090')

    expect(CLIENT_CONFIG_LAUNCHER).toBe('binary')
    expect(entry.command).toBe('mcpcut')
    expect(entry.args).toEqual(['connect', '--url', 'https://plane.example:8090'])
    expect(entry.env).toEqual({ MCP_AGENT_TOKEN: TOKEN })
    expect(entry.args.join(' ')).not.toContain(TOKEN)
  })

  test('the npx launcher pins the exact running version (PE9), never @latest', () => {
    const entry = stdioEntry('https://plane.example:8090', 'npx')

    expect(entry.command).toBe(NPX_COMMAND)
    expect(entry.args).toEqual(['-y', `mcpcut@${PRODUCT_VERSION}`, 'connect', '--url', 'https://plane.example:8090'])
  })

  test('an explicit version overrides the product version', () => {
    const document = clientConfigOf({
      serveUrl: 'https://h',
      token: TOKEN,
      form: 'stdio',
      launcher: 'npx',
      version: '9.9.9',
    })

    expect((document.mcpServers.mcpcut as StdioShape).args[1]).toBe('mcpcut@9.9.9')
  })

  test('plain http to another host carries --allow-http last; https and loopback do not', () => {
    expect(stdioEntry('http://203.0.113.7:8090').args).toEqual([
      'connect',
      '--url',
      'http://203.0.113.7:8090',
      '--allow-http',
    ])
    for (const url of ['http://127.0.0.1:8090', 'http://localhost:8090', 'http://[::1]:8090', 'https://h:8090']) {
      expect(stdioEntry(url).args).not.toContain('--allow-http')
    }
  })

  test('the npx form carries --allow-http the same way', () => {
    expect(stdioEntry('http://203.0.113.7:8090', 'npx').args.at(-1)).toBe('--allow-http')
  })
})

describe('needsAllowHttp is the bridge refusal, not a second opinion (PE8)', () => {
  test.each([
    'http://203.0.113.7:8090',
    'http://127.0.0.1:8090',
    'http://127.1.2.3:8090',
    'http://localhost:8090',
    'http://[::1]:8090',
    'https://plane.example',
    'http://plane.example',
    // The CRITICAL of phase 2: a DNS name that starts with "127." is NOT loopback.
    'http://127.evil.com:8090',
  ])('%s', (url) => {
    const parsed = parseBridgeUrl(url)
    if (!parsed.ok) throw new Error(parsed.message)

    expect(needsAllowHttp(url)).toBe(checkBridgeScheme(parsed.url, false) === 'refuse')
  })

  test('the phase 2 CRITICAL stays closed: 127.evil.com needs the flag', () => {
    expect(needsAllowHttp('http://127.evil.com:8090')).toBe(true)
  })

  test('an address the bridge cannot parse (the placeholder) needs no flag and does not throw', () => {
    expect(needsAllowHttp(SERVE_URL_PLACEHOLDER)).toBe(false)
  })
})

describe('clientConfigOf: the http form (a client that speaks HTTP natively)', () => {
  test('the url is the pool endpoint — the path nobody should have to guess — and the token rides in a Bearer header', () => {
    expect(httpEntry('https://plane.example:8090')).toEqual({
      url: 'https://plane.example:8090/mcp',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  })

  test('with placeholders it still names the pool path', () => {
    expect(httpEntry(SERVE_URL_PLACEHOLDER, TOKEN_PLACEHOLDER)).toEqual({
      url: '<serve-url>/mcp',
      headers: { Authorization: 'Bearer <token>' },
    })
  })
})

describe('clientConfigOf: placeholders and immutability', () => {
  test('both placeholders pass through the stdio form untouched', () => {
    const document = clientConfigOf({ serveUrl: SERVE_URL_PLACEHOLDER, token: TOKEN_PLACEHOLDER, form: 'stdio' })

    expect(document.mcpServers.mcpcut).toEqual({
      command: 'mcpcut',
      args: ['connect', '--url', '<serve-url>'],
      env: { MCP_AGENT_TOKEN: '<token>' },
    })
  })

  test('returns a new document on every call', () => {
    const input = { serveUrl: 'https://h', token: TOKEN, form: 'stdio' } as const

    expect(clientConfigOf(input)).not.toBe(clientConfigOf(input))
    expect(clientConfigOf(input)).toEqual(clientConfigOf(input))
  })
})
