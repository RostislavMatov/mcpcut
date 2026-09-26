#!/usr/bin/env node
// Writes the admin console's pixel font and tab icon into the preview page's
// directory, so mcpcut.com and the console draw them from the same bytes. The
// sources of truth are src/ui/assets/fonts.ts (base64) and favicon.ts (SVG);
// this script reads those modules as text (they are TypeScript, and a build is
// not needed for three constants) and writes site/fonts/*.woff2, the OFL
// licence and site/favicon.svg. tests/site/landing.test.ts fails if they differ.
//
//   node tools/site/build-assets.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const FONTS_MODULE = join(REPO_ROOT, 'src/ui/assets/fonts.ts')
const FAVICON_MODULE = join(REPO_ROOT, 'src/ui/assets/favicon.ts')
const LICENCE = join(REPO_ROOT, 'src/ui/assets/LICENSE-Silkscreen-OFL.txt')
const SITE_DIR = join(REPO_ROOT, 'site')

const WEIGHTS = ['400', '700']

/** The concatenated base64 of `const SILKSCREEN_<weight>_BASE64 = '…' + '…'`. */
function base64Of(source, weight) {
  const declaration = new RegExp(`const SILKSCREEN_${weight}_BASE64 =([\\s\\S]*?)\\n\\n`).exec(source)
  if (declaration === null) throw new Error(`fonts.ts: SILKSCREEN_${weight}_BASE64 not found`)
  const parts = [...declaration[1].matchAll(/'([A-Za-z0-9+/=]*)'/g)].map((match) => match[1])
  if (parts.length === 0) throw new Error(`fonts.ts: SILKSCREEN_${weight}_BASE64 is empty`)
  return parts.join('')
}

const source = readFileSync(FONTS_MODULE, 'utf8')
mkdirSync(join(SITE_DIR, 'fonts'), { recursive: true })
for (const weight of WEIGHTS) {
  const target = join(SITE_DIR, 'fonts', `silkscreen-${weight}.woff2`)
  writeFileSync(target, Buffer.from(base64Of(source, weight), 'base64'))
  process.stdout.write(`wrote ${target}\n`)
}
copyFileSync(LICENCE, join(SITE_DIR, 'LICENSE-Silkscreen-OFL.txt'))
process.stdout.write(`wrote ${join(SITE_DIR, 'LICENSE-Silkscreen-OFL.txt')}\n`)

const favicon = /const FAVICON_SOURCE = `([^`]*)`/.exec(readFileSync(FAVICON_MODULE, 'utf8'))
if (favicon === null) throw new Error('favicon.ts: FAVICON_SOURCE not found')
writeFileSync(join(SITE_DIR, 'favicon.svg'), favicon[1])
process.stdout.write(`wrote ${join(SITE_DIR, 'favicon.svg')}\n`)
