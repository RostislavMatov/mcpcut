import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * Plan R4: a tag stages the package on npm for a maintainer's 2FA approval.
 * No npm token exists anywhere — the publish job authenticates with GitHub's
 * OIDC token — and every third-party action in it is pinned by full SHA,
 * because a job that holds `id-token: write` behind a floating tag is a
 * supply-chain path straight to every agent that runs `npx mcpcut@…`.
 */

const PROJECT_ROOT = process.cwd()

function workflow(name: string): string {
  return readFileSync(join(PROJECT_ROOT, '.github/workflows', name), 'utf8')
}

const RELEASE = workflow('release.yml')

describe('release.yml', () => {
  test.each([
    'id-token: write',
    'npm stage publish',
    'package-manager-cache: false',
    'persist-credentials: false',
    "registry-url: 'https://registry.npmjs.org'",
  ])('carries %s', (line) => {
    expect(RELEASE).toContain(line)
  })

  test.each(['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'secrets.', 'npm publish'])('never carries %s', (text) => {
    expect(RELEASE).not.toContain(text)
  })

  test('every third-party action is pinned by a 40-character SHA', () => {
    const uses = RELEASE.split('\n').filter((line) => /^\s*(- )?uses: /.test(line))
    const thirdParty = uses.filter((line) => !line.includes('uses: ./'))

    expect(thirdParty.length).toBeGreaterThan(0)
    expect(thirdParty.filter((line) => !/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}\b/.test(line))).toEqual([])
  })

  test('the tag name reaches the shell through the environment, never through ${{ }}', () => {
    // `${{ github.ref_name }}` inside `run:` is pasted into the script before
    // the shell parses it — a tag name is attacker-shaped text. The file needs
    // no expression at all, so none is allowed anywhere.
    expect(RELEASE).not.toContain('${{')
  })

  test('the CI it runs first is the same workflow every push runs', () => {
    expect(RELEASE).toContain('uses: ./.github/workflows/ci.yml')
    expect(workflow('ci.yml')).toContain('workflow_call:')
  })
})
