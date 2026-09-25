import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

/**
 * The README is a landing page and the manual lives in `docs/guide/`, so the
 * two are held together by links. A heading renamed on one side breaks a link
 * on the other without a sound: GitHub renders a dead anchor as a link to the
 * top of the page. Every relative link and `#anchor` of the English documents
 * must resolve.
 */

const PROJECT_ROOT = process.cwd()

const GUIDE_DIR = 'docs/guide'

const CHECKED_FILES: readonly string[] = [
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'docs/ARCHITECTURE.md',
  'docs/release.md',
  'docs/deploy/README.md',
  ...readdirSync(join(PROJECT_ROOT, GUIDE_DIR))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `${GUIDE_DIR}/${name}`),
]

const HEADING = /^#{1,6} (.*?)\s*#*\s*$/

const LINK = /\]\(([^)\s]+)\)/g

const FENCE = '```'

/** A link with a scheme (`https:`, `mailto:`) leaves the repository; this test does not follow it. */
const EXTERNAL = /^[a-z]+:/

interface Line {
  readonly number: number
  readonly text: string
}

/** GitHub's anchor for a heading: lower case, punctuation dropped (hyphens and underscores kept), spaces to hyphens. */
function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, '')
    .replaceAll(' ', '-')
}

/** Lines outside fenced code: a `# comment` inside a code block is not a heading, a `](x)` there is not a link. */
function proseLines(text: string): readonly Line[] {
  const lines = text.split('\n')
  const fenceAt = lines.map((line) => line.startsWith(FENCE))
  return lines
    .map((line, index) => ({ number: index + 1, text: line }))
    .filter((_line, index) => !fenceAt[index] && fenceAt.slice(0, index).filter(Boolean).length % 2 === 0)
}

/** Every anchor a file offers; a repeated heading gets `-1`, `-2` … as GitHub numbers it. */
function anchorsOf(path: string): ReadonlySet<string> {
  const bases = proseLines(readFileSync(path, 'utf8')).flatMap(({ text }) => {
    const match = HEADING.exec(text)
    return match?.[1] === undefined ? [] : [anchorOf(match[1])]
  })
  return new Set(bases.map((base, index) => {
    const earlier = bases.slice(0, index).filter((other) => other === base).length
    return earlier === 0 ? base : `${base}-${earlier}`
  }))
}

/** `file:line: what is wrong` for every relative link of `file` (relative to `root`) that resolves to nothing. */
function brokenLinks(root: string, file: string): readonly string[] {
  const source = resolve(root, file)
  return proseLines(readFileSync(source, 'utf8')).flatMap(({ number, text }) =>
    [...text.matchAll(LINK)].flatMap(([, target = '']) => {
      if (EXTERNAL.test(target)) return []
      const [path = '', fragment = ''] = target.split('#')
      const destination = path === '' ? source : resolve(dirname(source), path)
      if (!existsSync(destination)) return [`${file}:${number}: no file ${target}`]
      if (fragment === '' || !destination.endsWith('.md')) return []
      return anchorsOf(destination).has(fragment) ? [] : [`${file}:${number}: no anchor ${target}`]
    }),
  )
}

describe('anchorOf: the anchor GitHub gives a heading', () => {
  test.each([
    ['Backup & restore', 'backup--restore'],
    ['First run (`mcpcut`)', 'first-run-mcpcut'],
    ['`policy.json` example', 'policyjson-example'],
    ['A console for a service on another host (`--remote`) (preview)', 'a-console-for-a-service-on-another-host---remote-preview'],
  ])('%s → #%s', (heading, anchor) => {
    expect(anchorOf(heading)).toBe(anchor)
  })
})

describe('brokenLinks: the check itself', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('names a missing file and a missing anchor, and ignores headings and links inside code', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcpcut-links-')))
    dirs.push(root)
    writeFileSync(join(root, 'other.md'), '# Other\n\n## Kept\n\n```\n## Not a heading\n```\n')
    writeFileSync(
      join(root, 'page.md'),
      [
        '# Page',
        '[ok](other.md#kept) [ok](#page) [out](https://example.com/x#y)',
        '[gone](missing.md) [renamed](other.md#not-a-heading) [dup](#page-1)',
        '```',
        '[inside code](missing-too.md)',
        '```',
      ].join('\n'),
    )

    expect(brokenLinks(root, 'page.md')).toEqual([
      'page.md:3: no file missing.md',
      'page.md:3: no anchor other.md#not-a-heading',
      'page.md:3: no anchor #page-1',
    ])
  })
})

describe('the links of the English documents', () => {
  test.each(CHECKED_FILES)('every relative link and anchor in %s resolves', (file) => {
    expect(brokenLinks(PROJECT_ROOT, file)).toEqual([])
  })
})
