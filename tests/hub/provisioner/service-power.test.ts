import { describe, expect, test } from 'vitest'
import { lastActivityFrom } from '../../../hub/src/provisioner/tenant-exec.js'
import { errorOf, execKindOf, FAKE_ACTIVITY_S, useProvisioner } from './provisioner-harness.js'

/**
 * Stop, start and status of one tenant (plan `hosted-path-and-ops`, Task C,
 * P5/P6): the hub stops an install nobody used for 60 days and starts it
 * again on its person's next visit; `status` tells it whether the container
 * runs and when the install last wrote its journal or state (`stat -c %Y`
 * over the data directory's SQLite files, run in the container).
 */

const ctx = useProvisioner()
const ALICE = { subdomain: 'alice', login: 'Alice', githubId: 1001 }
const FAKE_ACTIVITY_ISO = new Date(FAKE_ACTIVITY_S * 1000).toISOString()
const DATA = '/home/node/.mcpcut/data'

function aliceRunning(): boolean | undefined {
  return ctx.fake().containers().find((c) => c.name === 'mcpcut-t-alice')?.running
}

describe('status', () => {
  test('absent before create: nothing runs, no activity is known', async () => {
    expect(await ctx.service().status('alice')).toEqual({ state: 'absent', sizeBytes: null, running: false, lastActivityAt: null })
  })

  test('running: the latest mtime of the SQLite files, the volume size when Docker knows it', async () => {
    await ctx.service().create(ALICE)
    expect(await ctx.service().status('alice')).toEqual({
      state: 'running',
      sizeBytes: null,
      running: true,
      lastActivityAt: FAKE_ACTIVITY_ISO,
    })

    ctx.fake().setVolumeSize('mcpcut-t-alice', 4096)
    expect((await ctx.service().status('alice')).sizeBytes).toBe(4096)
  })

  test('asks `stat -c %Y` about exactly the four files, as user node', async () => {
    await ctx.service().create(ALICE)
    await ctx.service().status('alice')

    const stat = ctx.execs().find((argv) => execKindOf(argv) === 'stat')
    expect(stat).toEqual([
      'stat',
      '-c',
      '%Y',
      `${DATA}/journal.db`,
      `${DATA}/journal.db-wal`,
      `${DATA}/state.db`,
      `${DATA}/state.db-wal`,
    ])
    const execCreate = ctx
      .fake()
      .calls()
      .filter((call) => call.route === 'POST /containers/{id}/exec')
      .at(-1)
    expect((execCreate?.body as { User?: string }).User).toBe('node')
  })

  test('the newest of the files that exist wins; the WAL counts', async () => {
    await ctx.service().create(ALICE)
    ctx.answer((argv) => (execKindOf(argv) === 'stat' ? { exitCode: 1, stdout: '1700000000\n1800000000\n1750000000\n', stderr: 'stat: cannot statx x\n' } : undefined))

    expect((await ctx.service().status('alice')).lastActivityAt).toBe(new Date(1_800_000_000_000).toISOString())
  })

  test('stopped: no exec at all, activity unknown', async () => {
    await ctx.service().create(ALICE)
    await ctx.service().stop('alice')
    const execsBefore = ctx.execs().length

    expect(await ctx.service().status('alice')).toEqual({ state: 'exited', sizeBytes: null, running: false, lastActivityAt: null })
    expect(ctx.execs()).toHaveLength(execsBefore)
  })

  test('an answer stat never gives is a bad-output failure, never a guess', async () => {
    await ctx.service().create(ALICE)
    ctx.answer((argv) => (execKindOf(argv) === 'stat' ? { exitCode: 127, stderr: 'stat: not found\n' } : undefined))

    expect((await errorOf(ctx.service().status('alice'))).code).toBe('bad-output')
  })

  test('another tenant’s container under the name → not-ours', async () => {
    await ctx.docker().createContainer('mcpcut-t-alice', { Image: 'x', Labels: { 'mcpcut.tenant': 'eve' } })

    expect((await errorOf(ctx.service().status('alice'))).code).toBe('not-ours')
  })

  test('waits for a create of the same subdomain to finish (the keyed lock)', async () => {
    const created = ctx.service().create(ALICE)
    const status = ctx.service().status('alice')

    await created
    expect((await status).state).toBe('running')
  })
})

describe('stop and start', () => {
  test('stop stops the container and keeps everything else; start runs it again', async () => {
    await ctx.service().create(ALICE)

    await ctx.service().stop('alice')
    expect(aliceRunning()).toBe(false)
    expect(ctx.fake().volumes().map((v) => v.name)).toEqual(['mcpcut-t-alice'])

    await ctx.service().start('alice')
    expect(aliceRunning()).toBe(true)
    expect(ctx.logs().join('\n')).toMatch(/stopped alice[\s\S]*started alice/)
  })

  test('both are idempotent', async () => {
    await ctx.service().create(ALICE)

    await ctx.service().stop('alice')
    await expect(ctx.service().stop('alice')).resolves.toBeUndefined()
    await ctx.service().start('alice')
    await expect(ctx.service().start('alice')).resolves.toBeUndefined()
    expect(aliceRunning()).toBe(true)
  })

  test('a tenant that does not exist → not-found', async () => {
    expect((await errorOf(ctx.service().stop('nobody'))).code).toBe('not-found')
    expect((await errorOf(ctx.service().start('nobody'))).code).toBe('not-found')
  })

  test('another tenant’s container is neither stopped nor started', async () => {
    const eve = await ctx.docker().createContainer('mcpcut-t-alice', { Image: 'x', Labels: { 'mcpcut.tenant': 'eve' } })
    await ctx.docker().startContainer(eve.id)

    expect((await errorOf(ctx.service().stop('alice'))).code).toBe('not-ours')
    expect(aliceRunning()).toBe(true)
    await ctx.docker().stopContainer(eve.id, 1)
    expect((await errorOf(ctx.service().start('alice'))).code).toBe('not-ours')
    expect(aliceRunning()).toBe(false)
  })

  test('a bad subdomain is refused before Docker', async () => {
    const before = ctx.fake().calls().length

    expect((await errorOf(ctx.service().stop('a/b'))).code).toBe('invalid-input')
    expect((await errorOf(ctx.service().start(''))).code).toBe('invalid-input')
    expect(ctx.fake().calls()).toHaveLength(before)
  })

  test('a Docker failure surfaces as a docker error', async () => {
    await ctx.service().create(ALICE)
    ctx.fake().failNext('POST /containers/{id}/stop', 500, 'daemon trouble')

    expect((await errorOf(ctx.service().stop('alice'))).code).toBe('docker')
  })
})

describe('lastActivityFrom', () => {
  test.each([
    ['', null],
    ['\n', null],
    ['1700000000\n', '2023-11-14T22:13:20.000Z'],
    ['1700000000\n1700000001\n', '2023-11-14T22:13:21.000Z'],
    [' 1700000000 \r\n', '2023-11-14T22:13:20.000Z'],
  ])('%j → %s', (stdout, expected) => {
    expect(lastActivityFrom(stdout)).toBe(expected)
  })

  test.each(['abc\n', '17e9\n', '-1\n', '1700000000 1\n', `${'9'.repeat(14)}\n`])('%j is not stat output', (stdout) => {
    expect(() => lastActivityFrom(stdout)).toThrow(/stat/)
  })
})
