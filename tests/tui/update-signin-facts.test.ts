import { describe, expect, test } from 'vitest'
import type { KeyEvent } from '../../src/tui/keys.js'
import { initialModel, type Model, type SigninScreen, type TerminalSize } from '../../src/tui/model.js'
import type { ServiceSummary } from '../../src/tui/services-summary.js'
import { update } from '../../src/tui/update.js'

/**
 * The sign-in screen's host facts across one attempt to sign in (phase 6,
 * F6b). What the daemons are doing and where the bootstrap token file is are
 * true of the HOST: a token that was refused changes neither, so the screen
 * that shows the refusal still carries both. Before this the reducer rebuilt
 * the screen from its form alone and a typo made the services line vanish.
 *
 * New file rather than a section of `update.test.ts`, which is past the file
 * budget and is split along its own lines in a later task (F9).
 */

const SIZE: TerminalSize = { columns: 80, rows: 24 }
const TOKEN_PATH = '/srv/mcpcut/bootstrap-token'
const SERVICES: readonly ServiceSummary[] = [
  { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091 },
]

const ENTER: KeyEvent = { kind: 'enter' }

function signinOf(model: Model): SigninScreen {
  if (model.screen.kind !== 'signin') throw new Error(`expected the sign-in screen, got ${model.screen.kind}`)
  return model.screen
}

/** A sign-in screen that knows both host facts, with a token typed into it. */
function knowingModel(): Model {
  const opened = initialModel(SIZE, undefined, { bootstrapTokenPath: TOKEN_PATH })
  const withServices = update(opened, { kind: 'services', statuses: SERVICES }).model
  return [...'mcpa_x'].reduce(
    (model, char) => update(model, { kind: 'key', key: { kind: 'char', char } }).model,
    withServices,
  )
}

describe('the sign-in screen keeps its host facts across an attempt', () => {
  test('a services answer keeps the bootstrap file path', () => {
    const screen = signinOf(knowingModel())

    expect(screen.services).toBe(SERVICES)
    expect(screen.bootstrapTokenPath).toBe(TOKEN_PATH)
  })

  test('Enter hands the token over and keeps both facts on the busy screen', () => {
    const step = update(knowingModel(), { kind: 'key', key: ENTER })
    const screen = signinOf(step.model)

    expect(step.effects).toEqual([{ kind: 'signin', token: 'mcpa_x' }])
    expect(screen.busy).toBe(true)
    expect(screen.services).toBe(SERVICES)
    expect(screen.bootstrapTokenPath).toBe(TOKEN_PATH)
  })

  test('a refused token keeps both facts beside the notice', () => {
    const busy = update(knowingModel(), { kind: 'key', key: ENTER }).model
    const screen = signinOf(
      update(busy, { kind: 'signin-result', result: { kind: 'unknown' } }).model,
    )

    expect(screen.busy).toBe(false)
    expect(screen.notice).not.toBe('')
    expect(screen.services).toBe(SERVICES)
    expect(screen.bootstrapTokenPath).toBe(TOKEN_PATH)
  })

  test('a screen that never knew of a file stays without the key', () => {
    const busy = update(initialModel(SIZE), { kind: 'key', key: ENTER }).model
    const screen = signinOf(
      update(busy, { kind: 'signin-result', result: { kind: 'unknown' } }).model,
    )

    expect('bootstrapTokenPath' in screen).toBe(false)
    expect('services' in screen).toBe(false)
  })
})
