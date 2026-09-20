import { describe, expect, test } from 'vitest'
import type { KeyEvent } from '../../src/tui/keys.js'
import type { Model, Msg, Step } from '../../src/tui/model.js'
import type { RunResult } from '../../src/tui/output.js'
import { update } from '../../src/tui/update.js'
import { firstOwnerModel, FIRST_OWNER_FAILED_NOTICE } from '../../src/tui/update-first-owner.js'

/**
 * The first-owner screen (2026-09-19): what the console opens on when the
 * install has no admin. A name, one sessionless `admin add`, the token held
 * on screen, and a sign-in the operator does not have to type.
 */

const SIZE = { columns: 80, rows: 24 }
const TOKEN = 'mcpa_console-owner-token'

function key(event: KeyEvent): Msg {
  return { kind: 'key', key: event }
}

function typed(model: Model, text: string): Model {
  return [...text].reduce((next, char) => update(next, key({ kind: 'char', char })).model, model)
}

function result(overrides: Partial<RunResult>): Msg {
  return {
    kind: 'first-owner-result',
    result: { argv: [], display: [], exitCode: 0, stdout: '', stderr: '', ...overrides },
  }
}

function submitted(name: string): Step {
  return update(typed(firstOwnerModel(SIZE), name), key({ kind: 'enter' }))
}

function heldToken(): Model {
  const { model } = submitted('alice')
  return update(model, result({ stdout: `admin: alice\nrole: owner\ntoken: ${TOKEN}\n` })).model
}

describe('first-owner: the form', () => {
  test('Enter with a valid name runs a sessionless `admin add <name> --role owner`, once', () => {
    const step = submitted('alice')

    expect(step.effects).toEqual([
      {
        kind: 'first-owner-run',
        request: expect.objectContaining({ argv: ['admin', 'add', 'alice', '--role', 'owner'], mintsToken: true }),
      },
    ])
    // Busy: a second Enter must not mint a second owner behind the first.
    expect(update(step.model, key({ kind: 'enter' })).effects).toEqual([])
  })

  test('an empty or malformed name runs nothing and says why on the field', () => {
    for (const name of ['', 'Not A Name', '-dash']) {
      const step = submitted(name)

      expect([name, step.effects]).toEqual([name, []])
      const screen = step.model.screen
      expect(screen.kind === 'first-owner' && screen.stage.kind === 'form' && screen.stage.form.fields[0]?.error).toBeTruthy()
    }
  })

  test('surrounding spaces are not part of the name', () => {
    const [effect] = submitted(' alice ').effects

    expect(effect?.kind === 'first-owner-run' && effect.request.argv[2]).toBe('alice')
  })

  test('Esc while the command is in flight does NOT leave: the owner being created would lose its only token', () => {
    const busy = submitted('alice').model

    const step = update(busy, key({ kind: 'escape' }))

    expect(step.effects).toEqual([])
    expect(step.model).toEqual(busy)
  })

  test('Esc leaves', () => {
    expect(update(firstOwnerModel(SIZE), key({ kind: 'escape' })).effects).toEqual([{ kind: 'quit', exitCode: 0 }])
  })
})

describe('first-owner: the answer', () => {
  test('a minted owner is held on screen', () => {
    const screen = heldToken().screen

    expect(screen.kind === 'first-owner' && screen.stage).toEqual({
      kind: 'hold',
      admin: { name: 'alice', token: TOKEN },
      quitAsked: false,
    })
  })

  test('a refusal — somebody made an admin first — becomes the sign-in screen with the reason', () => {
    const step = update(submitted('alice').model, result({ exitCode: 1, stderr: 'admin: a personal token is required\n' }))

    const screen = step.model.screen
    expect(screen.kind).toBe('signin')
    expect(screen.kind === 'signin' && screen.notice).toContain('a personal token is required')
    // `opened` fired on the first-owner screen, so this sign-in screen asks about the daemons itself.
    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
  })

  test('a success whose token cannot be read says so instead of showing nothing', () => {
    const step = update(submitted('alice').model, result({ stdout: 'admin: alice\n' }))

    const screen = step.model.screen
    expect(screen.kind === 'signin' && screen.notice).toBe(FIRST_OWNER_FAILED_NOTICE)
  })
})

describe('first-owner: holding the token', () => {
  test('y signs in with the token it holds, and the token leaves the model', () => {
    const step = update(heldToken(), key({ kind: 'char', char: 'y' }))

    expect(step.effects).toEqual([{ kind: 'signin', token: TOKEN }])
    expect(step.model.screen.kind).toBe('signin')
    expect(JSON.stringify(step.model)).not.toContain(TOKEN)
  })

  test('q asks first; anything but y keeps the token on screen', () => {
    const asked = update(heldToken(), key({ kind: 'char', char: 'q' }))
    expect(asked.effects).toEqual([])
    expect(asked.model.screen.kind === 'first-owner' && asked.model.screen.stage).toMatchObject({ quitAsked: true })

    const kept = update(asked.model, key({ kind: 'char', char: 'n' }))
    expect(kept.model.screen.kind === 'first-owner' && kept.model.screen.stage).toMatchObject({ kind: 'hold', quitAsked: false })

    const left = update(asked.model, key({ kind: 'char', char: 'y' }))
    expect(left.effects).toEqual([{ kind: 'quit', exitCode: 0 }])
  })

  test('Enter, a tick and a stray result do not dismiss it', () => {
    const held = heldToken()

    for (const msg of [key({ kind: 'enter' }), { kind: 'tick' } as Msg, result({ exitCode: 1 })]) {
      expect(update(held, msg).model.screen).toEqual(held.screen)
    }
  })
})
