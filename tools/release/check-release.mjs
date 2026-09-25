#!/usr/bin/env node
// prepublishOnly guard (PRD phase 6, plan R3): a version number on npm can
// never be reused, so the one irreversible command of a release refuses to
// run from anything but a clean tree whose HEAD is tagged `v<version>`, and
// not with a `bin` that npm would quietly drop: npm 11 `publish` (unlike
// `pack`) calls a `./`-prefixed bin path an invalid script name and uploads
// the manifest without it — a package that installs no command.
// Under `npm publish --dry-run` the findings are warnings and the rehearsal
// goes on. No `git` on PATH throws, and the publish does not happen: that is
// the fail-closed side on purpose.
//
// Usage (npm runs it; by hand only to see what it would say):
//   node tools/release/check-release.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** What makes publishing from here wrong; empty = go. Pure, for the tests. */
export function releaseProblems({ version, isClean, tagsAtHead, ciTag, bin }) {
  const expectedTag = `v${version}`
  const problems = [...binProblems(bin)]
  if (!isClean) {
    problems.push('the working tree has uncommitted changes — the tarball would not be the tagged commit')
  }
  if (!tagsAtHead.includes(expectedTag) && ciTag !== expectedTag) {
    problems.push(`HEAD is not tagged ${expectedTag} — tag the release commit first (git tag -a ${expectedTag})`)
  }
  return problems
}

function binProblems(bin) {
  if (bin === undefined || bin === null || Object.keys(bin).length === 0) {
    return ['package.json has no bin — the package would install no command']
  }
  return Object.entries(bin)
    .filter(([, path]) => path.startsWith('./'))
    .map(([name, path]) => `bin.${name} is "${path}" — npm publish drops a ./-prefixed bin; write "${path.slice(2)}"`)
}

function gitLines(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '')
}

function main() {
  const { version, bin } = JSON.parse(readFileSync('package.json', 'utf8'))
  const problems = releaseProblems({
    version,
    bin,
    isClean: gitLines(['status', '--porcelain']).length === 0,
    tagsAtHead: gitLines(['tag', '--points-at', 'HEAD']),
    ciTag: process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined,
  })
  const isDryRun = process.env.npm_config_dry_run === 'true'
  for (const problem of problems) process.stderr.write(`${isDryRun ? 'warning' : 'error'}: ${problem}\n`)
  process.exitCode = problems.length > 0 && !isDryRun ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
