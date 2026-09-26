import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize, relative, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { FAVICON } from '../../src/ui/assets/favicon.js'
import { SILKSCREEN_400, SILKSCREEN_700 } from '../../src/ui/assets/fonts.js'

/**
 * `site/` is the preview page served at https://mcpcut.com (plan
 * `mcpcut-domain-and-hosted`, track A). It is a static page read by strangers,
 * so it carries the same promises as the README and must not drift from it:
 * the words the project refuses to use, a Quick start that is the README's,
 * a pixel font that is the admin console's. It is also served under a CSP of
 * `default-src 'none'` with `'self'` for styles, fonts and images — anything
 * inline or from another origin would silently not load.
 */

const PROJECT_ROOT = process.cwd()
const SITE_DIR = join(PROJECT_ROOT, 'site')
const PAGE = join(SITE_DIR, 'index.html')
const STYLESHEET = join(SITE_DIR, 'site.css')
const README = join(PROJECT_ROOT, 'README.md')

/** The public origin; an absolute URL on it must name a file this directory serves. */
const SITE_ORIGIN = 'https://mcpcut.com/'

/** Where an outbound link may point: the repository and the npm package, nothing else. */
const REPOSITORY_URL = 'https://github.com/RostislavMatov/mcpcut'
const NPM_URL = 'https://www.npmjs.com/package/mcpcut'

/** A GitHub link into the repository's tree; the path after `main/` must exist here. */
const REPOSITORY_FILE_LINK = new RegExp(`^${REPOSITORY_URL.replace(/[.]/g, '\\.')}/(?:blob|tree)/main/([^#?]+)`)

const OG_IMAGE_WIDTH = 1200
const OG_IMAGE_HEIGHT = 630

/** How far after "tamper-evident" the qualifier may stand (characters of text). */
const QUALIFIER_WINDOW = 80

const FONT_FILES: ReadonlyArray<readonly [string, Buffer | string]> = [
  ['fonts/silkscreen-400.woff2', SILKSCREEN_400.body],
  ['fonts/silkscreen-700.woff2', SILKSCREEN_700.body],
]

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** The page as a reader sees it: tags dropped, entities decoded, whitespace collapsed. */
function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ')
}

/** Every value of `name="…"` on any tag. */
function attributeValues(html: string, name: string): string[] {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'gi')
  return [...html.matchAll(pattern)].map((match) => decodeEntities(match[1] ?? ''))
}

/** `<meta … content="…">` values: Open Graph and Twitter card URLs live here. */
function metaUrls(html: string): string[] {
  return attributeValues(html, 'content').filter((value) => /^https?:\/\//.test(value))
}

function isExternal(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)
}

/** A site-relative URL (or one on the public origin) → the file under `site/` it serves. */
function siteFileOf(url: string): string {
  const path = (url.startsWith(SITE_ORIGIN) ? url.slice(SITE_ORIGIN.length - 1) : url).split(/[?#]/)[0] ?? ''
  const local = path.startsWith('/') ? join(SITE_DIR, path) : join(SITE_DIR, path)
  return path === '' || path.endsWith('/') ? join(local, 'index.html') : local
}

function pngSize(path: string): readonly [number, number] {
  const bytes = readFileSync(path)
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

/** GitHub's anchor for a README heading (enough for the headings the page links to). */
function readmeAnchors(): Set<string> {
  return new Set(
    [...read(README).matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
      (match[1] ?? '').trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-'),
    ),
  )
}

const html = read(PAGE)
/** Comments may name what the sheet does not do; only the rules are checked. */
const css = read(STYLESHEET).replace(/\/\*[\s\S]*?\*\//g, '')
const text = visibleText(html)

describe('site/ — the preview page at mcpcut.com', () => {
  test('the page and its stylesheet exist', () => {
    expect(existsSync(PAGE)).toBe(true)
    expect(existsSync(STYLESHEET)).toBe(true)
  })

  test('declares its language, viewport, title and description', () => {
    expect(html).toMatch(/<html lang="en">/)
    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1">/)
    expect(html).toMatch(/<title>[^<]+<\/title>/)
    expect(html).toMatch(/<meta name="description" content="[^"]{50,}">/)
    expect(html).toContain(`<link rel="canonical" href="${SITE_ORIGIN}">`)
  })

  test('carries an Open Graph and Twitter card pointing at a 1200×630 image it serves', () => {
    expect(html).toContain(`<meta property="og:image" content="${SITE_ORIGIN}og.png">`)
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    const image = join(SITE_DIR, 'og.png')
    expect(existsSync(image)).toBe(true)
    expect(pngSize(image)).toEqual([OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT])
  })
})

describe('site/ — the words the project refuses', () => {
  test('never says tamper-proof or audit-ready', () => {
    for (const source of [text, css]) {
      expect(source).not.toMatch(/tamper[- ]?proof/i)
      expect(source).not.toMatch(/audit[- ]?ready/i)
    }
  })

  test('says tamper-evident only with "external anchor" right after it', () => {
    const lower = text.toLowerCase()
    let at = lower.indexOf('tamper-evident')
    while (at !== -1) {
      const window = lower.slice(at, at + QUALIFIER_WINDOW)
      expect(window, `"${text.slice(at, at + QUALIFIER_WINDOW)}"`).toContain('external anchor')
      at = lower.indexOf('tamper-evident', at + 1)
    }
  })

  test('the network features are labelled preview', () => {
    for (const feature of ['--remote', 'connect --url']) {
      if (!text.includes(feature)) continue
      const at = text.indexOf(feature)
      expect(text.slice(Math.max(0, at - QUALIFIER_WINDOW), at + QUALIFIER_WINDOW).toLowerCase()).toContain('preview')
    }
  })

  test('promises no sign-up and no hosted service', () => {
    expect(text).not.toMatch(/sign[- ]?up|register now|create an account|hosted (?:service|version|plan)|free trial/i)
  })
})

describe('site/ — self-contained under a strict CSP', () => {
  test('has no script, no inline style element and no style attribute', () => {
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<style/i)
    expect(html).not.toMatch(/\sstyle\s*=/i)
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
  })

  test('loads every stylesheet, font, icon and image from this directory', () => {
    const loaded = [
      ...attributeValues(html, 'src'),
      ...[...html.matchAll(/<link\b[^>]*>/gi)]
        .map((match) => match[0])
        .filter((tag) => !/rel="canonical"/.test(tag))
        .flatMap((tag) => attributeValues(tag, 'href')),
    ]
    expect(loaded.length).toBeGreaterThan(0)
    for (const url of loaded) {
      expect(isExternal(url), url).toBe(false)
      expect(existsSync(siteFileOf(url)), url).toBe(true)
    }
  })

  test('the stylesheet imports nothing and reads fonts from this directory', () => {
    expect(css).not.toMatch(/@import/i)
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((match) => match[1] ?? '')
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(isExternal(url), url).toBe(false)
      expect(existsSync(siteFileOf(url)), url).toBe(true)
    }
  })

  test('every link stays on the page, on the repository or on the npm package', () => {
    const links = [...html.matchAll(/<a\b[^>]*>/gi)].flatMap((match) => attributeValues(match[0], 'href'))
    expect(links.length).toBeGreaterThan(0)
    for (const url of links) {
      if (url.startsWith('#')) {
        expect(html, url).toContain(`id="${url.slice(1)}"`)
        continue
      }
      if (!isExternal(url)) {
        expect(existsSync(siteFileOf(url)), url).toBe(true)
        continue
      }
      const allowed =
        url === REPOSITORY_URL ||
        url.startsWith(`${REPOSITORY_URL}/`) ||
        url.startsWith(`${REPOSITORY_URL}#`) ||
        url === NPM_URL
      expect(allowed, url).toBe(true)
      if (url.startsWith(`${REPOSITORY_URL}#`)) expect(readmeAnchors().has(url.slice(REPOSITORY_URL.length + 1)), url).toBe(true)
      const file = REPOSITORY_FILE_LINK.exec(url)?.[1]
      if (file !== undefined) expect(existsSync(join(PROJECT_ROOT, decodeURIComponent(file))), url).toBe(true)
    }
  })

  test('absolute URLs on mcpcut.com name files this directory serves', () => {
    for (const url of metaUrls(html).filter((value) => value.startsWith(SITE_ORIGIN))) {
      expect(existsSync(siteFileOf(url)), url).toBe(true)
    }
  })

  test('no path escapes the site directory', () => {
    for (const url of [...attributeValues(html, 'src'), ...attributeValues(html, 'href')].filter((u) => !isExternal(u))) {
      const file = normalize(siteFileOf(url))
      expect(relative(SITE_DIR, resolve(file)).startsWith('..'), url).toBe(false)
    }
  })
})

describe('site/ — one truth with the README and the console', () => {
  test('every command block on the page is a line of the README', () => {
    const readme = read(README)
    const blocks = [...html.matchAll(/<pre\b[^>]*data-from-readme[^>]*>([\s\S]*?)<\/pre>/gi)].map((match) =>
      decodeEntities((match[1] ?? '').replace(/<[^>]*>/g, '')).trim(),
    )
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      for (const line of block.split('\n').map((l) => l.trim()).filter(Boolean)) {
        expect(readme, line).toContain(line)
      }
    }
  })

  test('the pixel font is byte for byte the admin console\'s', () => {
    for (const [path, body] of FONT_FILES) {
      const file = join(SITE_DIR, path)
      expect(existsSync(file), path).toBe(true)
      expect(readFileSync(file).equals(Buffer.from(body)), path).toBe(true)
    }
  })

  test('the tab icon is the console\'s', () => {
    expect(read(join(SITE_DIR, 'favicon.svg'))).toBe(FAVICON.body)
  })

  test('the font licence ships beside the font', () => {
    const licence = join(SITE_DIR, 'LICENSE-Silkscreen-OFL.txt')
    expect(existsSync(licence)).toBe(true)
    expect(statSync(licence).size).toBe(statSync(join(PROJECT_ROOT, 'src/ui/assets/LICENSE-Silkscreen-OFL.txt')).size)
  })
})
