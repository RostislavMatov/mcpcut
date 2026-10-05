import { describe, expect, test } from 'vitest'
import { isIndexed, skipReasonOfName } from '../../../src/files/search/index-scope.js'

const on = (path: string) => ({ path, enabled: true, setAt: '2026-10-05T10:00:00.000Z' })
const off = (path: string) => ({ ...on(path), enabled: false })

describe('isIndexed', () => {
  test('a path with no rule above it is not indexed', () => {
    expect(isIndexed('/data/a/x.md', [], 'linux')).toBe(false)
    expect(isIndexed('/data/b/x.md', [on('/data/a')], 'linux')).toBe(false)
  })

  test('a rule covers its folder and everything under it', () => {
    expect(isIndexed('/data/a/x.md', [on('/data/a')], 'linux')).toBe(true)
    expect(isIndexed('/data/a/deep/er/x.md', [on('/data/a')], 'linux')).toBe(true)
  })

  test('the deepest rule decides: a cut-out subfolder is not indexed, a deeper rule switches it back on', () => {
    const rules = [on('/data/a'), off('/data/a/private'), on('/data/a/private/open')]

    expect(isIndexed('/data/a/private/x.md', rules, 'linux')).toBe(false)
    expect(isIndexed('/data/a/private/open/x.md', rules, 'linux')).toBe(true)
    expect(isIndexed('/data/a/y.md', rules, 'linux')).toBe(true)
  })

  test('matching is by segment, never by string prefix', () => {
    expect(isIndexed('/data/ab/x.md', [on('/data/a')], 'linux')).toBe(false)
  })

  test('volumes that fold case match regardless of case; others do not', () => {
    expect(isIndexed('C:\\Data\\A\\x.md', [on('c:\\data\\a')], 'win32')).toBe(true)
    expect(isIndexed('/Data/a/x.md', [on('/data/a')], 'linux')).toBe(false)
  })
})

describe('skipReasonOfName', () => {
  test.each([
    '.env',
    '.env.local',
    'prod.env',
    'a/b/server.pem',
    'my.key',
    'x.p12',
    'x.pfx',
    'x.jks',
    'x.keystore',
    'x.kdbx',
    'x.crt',
    'x.cer',
    'x.der',
    'x.csr',
    'id_rsa',
    'id_rsa.pub',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    '.npmrc',
    '.pypirc',
    '.netrc',
    '.pgpass',
    '.htpasswd',
    '.git-credentials',
    'credentials',
    'credentials.json',
    'secrets.yml',
    'x.secret',
    'x.secrets',
    'terraform.tfstate',
    'prod.tfvars',
    'kubeconfig',
    'office.ovpn',
    'service-account-prod.json',
    'DIR/.ENV',
    'Id_RSA',
  ])('%s is a secret-like name', (name) => {
    expect(skipReasonOfName(name)).toBe('secret-like name')
  })

  test.each(['.git/config', 'a/node_modules/x.js', '.ssh/notes.md', 'x/.aws/y.txt', '.gnupg/z', '.hg/a', '.svn/b'])('%s is in a skipped folder', (name) => {
    expect(skipReasonOfName(name)).toBe('skipped folder')
  })

  test('a skipped folder wins over a secret-like name', () => {
    expect(skipReasonOfName('.git/id_rsa')).toBe('skipped folder')
  })

  test.each(['environment.md', 'keys.md', 'monkey.ts', 'README.md', 'src/env.ts', 'credentials-guide.md', 'secrets-policy', 'notes/id_rsa_help.md', 'kubeconfig.md', 'service-accounts.md'])(
    '%s is indexed',
    (name) => {
      const reason = skipReasonOfName(name)
      // id_rsa* is a deliberate prefix match: `id_rsa_help.md` is skipped, the rest are indexed.
      expect(reason).toBe(name === 'notes/id_rsa_help.md' ? 'secret-like name' : null)
    },
  )
})
