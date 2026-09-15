import { describe, expect, test } from 'vitest'
import { ansiStyle, padRight, plainStyle } from '../../src/tui/ansi.js'
import { visibleSections } from '../../src/tui/catalogue/index.js'
import {
  ACTION_COLUMN_WIDTH,
  COLUMN_GAP,
  exitLine,
  HEADER_ROWS,
  ONE_TIME_TOKEN_MARKER,
  SIGNIN_TITLE,
} from '../../src/tui/constants.js'
import {
  SIGNIN_BOOTSTRAP_PREFIX,
  SIGNIN_SERVICES_DOWN_HINT,
  SIGNIN_SERVICES_EXTERNAL_HINT,
  SIGNIN_SERVICES_PREFIX,
  TOKEN_HOLD_BANNER,
  TOKEN_HOLD_FOOTER,
} from '../../src/tui/constants-live.js'
import {
  initialModel,
  type MainScreen,
  mainScreenOf,
  type Model,
  type Session,
  type TerminalSize,
} from '../../src/tui/model.js'
import { type OutputPanel, outputPanelOf } from '../../src/tui/output.js'
import { render } from '../../src/tui/render.js'
import { SIGNIN_BUSY_TEXT, SIGNIN_FOOTER } from '../../src/tui/render-signin.js'
import { servicesHeaderPart, type ServiceSummary } from '../../src/tui/services-summary.js'
import { signedOut } from '../../src/tui/update-signin.js'

/**
 * The two screens phase 5 gave words to: the sign-in screen, which now says
 * what the daemons are doing before anybody has signed in, and the token-hold
 * pane, which stands between a one-time token and the screen that would take
 * it away.
 *
 * Both are asserted the way the rest of the renderer is — a model in, lines
 * out — and both carry the same shape contract as every other frame: exactly
 * `rows` lines of exactly `columns` characters, at every terminal size the
 * console may be handed. `render.test.ts` is at its size budget, so these
 * cases live here rather than beside their neighbours.
 */

const OWNER: Session = { adminName: 'alice', role: 'owner' }

const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 }

/** The same table `render.test.ts` walks, so the new pane is held to it too. */
const SIZES: readonly TerminalSize[] = [
  { columns: 80, rows: 24 },
  { columns: 40, rows: 10 },
  { columns: 200, rows: 50 },
  { columns: 20, rows: 5 },
]

const RUNNING_SERVICES: readonly ServiceSummary[] = [
  { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091 },
  { service: 'serve', state: 'running', host: '127.0.0.1', port: 8090 },
]

const DOWN_SERVICES: readonly ServiceSummary[] = [
  { service: 'ui', state: 'stopped', host: '127.0.0.1', port: 8091 },
  { service: 'serve', state: 'running', host: '127.0.0.1', port: 8090 },
]

const EXTERNAL_SERVICES: readonly ServiceSummary[] = [
  { service: 'ui', state: 'stale', host: '127.0.0.1', port: 8091 },
  { service: 'serve', state: 'external', host: '127.0.0.1', port: 8090 },
]

/** Only the fields a case overrides; written out so optional props stay optional. */
interface SigninPatch {
  readonly services?: readonly ServiceSummary[]
  readonly notice?: string
  readonly busy?: boolean
  readonly bootstrapTokenPath?: string
}

function signinModel(patch: SigninPatch = {}, size: TerminalSize = DEFAULT_SIZE): Model {
  const model = initialModel(size)
  if (model.screen.kind !== 'signin') throw new Error('expected a sign-in screen')

  return { ...model, screen: { ...model.screen, ...patch } }
}

/** The same model, told that something other than mcpcut supervises the daemons. */
function externalModel(patch: SigninPatch = {}): Model {
  return { ...signinModel(patch), install: { supervisor: 'external' } }
}

function tokenPanel(): OutputPanel {
  return outputPanelOf({
    argv: ['admin', 'add', 'alice', '--role', 'operator'],
    display: ['admin', 'add', 'alice', '--role', 'operator'],
    exitCode: 0,
    stdout: `admin: alice\ntoken: mcpa_secret\n${ONE_TIME_TOKEN_MARKER}\n`,
    stderr: '',
  })
}

function tokenHoldModel(size: TerminalSize = DEFAULT_SIZE): Model {
  const screen = mainScreenOf(OWNER, visibleSections(OWNER.role))
  if (screen.kind !== 'main') throw new Error('expected a main screen')

  const held: MainScreen = { ...screen, pane: { kind: 'token-hold' }, output: tokenPanel() }

  return { screen: held, size }
}

/** The pane half of one body row, the way the main screen lays a row out. */
function paneOf(line: string | undefined): string {
  return (line ?? '').slice(ACTION_COLUMN_WIDTH + COLUMN_GAP)
}

function joined(lines: readonly string[]): string {
  return lines.join('\n')
}

describe('render-signin: the notice line', () => {
  /**
   * The notice an unreadable store leaves is a raw `error.message` — text the
   * console did not write. `padRight` strips escapes on the way out, but the
   * block is CENTRED on the longest line it is given, and a length measured
   * before that strip counts bytes nobody will see: the whole block slides
   * left by however many invisible characters the notice carried.
   */
  const VISIBLE_NOTICE = 'store unreadable: bad-name at /var/lib/mcpcut/state.db'
  const HOSTILE_NOTICE = 'store unreadable: \x1b[2Kbad\u200b-name at /var/lib/mcpcut/state.db'

  test('an escape sequence in it never reaches the frame, at any size', () => {
    for (const size of SIZES) {
      const lines = render(signinModel({ notice: HOSTILE_NOTICE }, size), plainStyle)

      expect(joined(lines)).not.toContain('\x1b')
      expect(joined(lines)).not.toContain('\u200b')
      expect(lines).toHaveLength(size.rows)
      expect(lines.every((line) => line.length === size.columns)).toBe(true)
    }
  })

  test('nor is it counted as width: the block sits where the visible text puts it', () => {
    for (const size of SIZES) {
      const hostile = render(signinModel({ notice: HOSTILE_NOTICE }, size), plainStyle)
      const visible = render(signinModel({ notice: VISIBLE_NOTICE }, size), plainStyle)

      expect(hostile, `at ${size.columns}x${size.rows}`).toEqual(visible)
    }
  })
})

describe('render-signin: the services banner of the sign-in screen', () => {
  test('says nothing about services before status has answered', () => {
    const text = joined(render(signinModel(), plainStyle))

    expect(text).toContain(SIGNIN_TITLE)
    expect(text).not.toContain(SIGNIN_SERVICES_PREFIX)
    expect(text).not.toContain(SIGNIN_SERVICES_DOWN_HINT)
  })

  test('nor when status answered with no services at all', () => {
    const text = joined(render(signinModel({ services: [] }), plainStyle))

    expect(text).not.toContain(SIGNIN_SERVICES_PREFIX)
    expect(text).not.toContain(SIGNIN_SERVICES_DOWN_HINT)
  })

  test('shows the services line once status answered', () => {
    const text = joined(render(signinModel({ services: RUNNING_SERVICES }), plainStyle))

    expect(text).toContain(`${SIGNIN_SERVICES_PREFIX}${servicesHeaderPart(RUNNING_SERVICES)}`)
  })

  test('and no hint at all when everything runs', () => {
    const text = joined(render(signinModel({ services: RUNNING_SERVICES }), plainStyle))

    expect(text).not.toContain(SIGNIN_SERVICES_DOWN_HINT)
    expect(text).not.toContain(SIGNIN_SERVICES_EXTERNAL_HINT)
  })

  test('says what to do about a service that is down', () => {
    const text = joined(render(signinModel({ services: DOWN_SERVICES }), plainStyle))

    expect(text).toContain(`${SIGNIN_SERVICES_PREFIX}${servicesHeaderPart(DOWN_SERVICES)}`)
    expect(text).toContain(SIGNIN_SERVICES_DOWN_HINT)
    expect(text).not.toContain(SIGNIN_SERVICES_EXTERNAL_HINT)
  })

  test('and says who manages them instead under an external supervisor', () => {
    const text = joined(render(externalModel({ services: EXTERNAL_SERVICES }), plainStyle))

    expect(text).toContain(SIGNIN_SERVICES_EXTERNAL_HINT)
    expect(text).not.toContain(SIGNIN_SERVICES_DOWN_HINT)
  })

  test('an external supervisor whose services all answer still gets no hint', () => {
    const text = joined(render(externalModel({ services: RUNNING_SERVICES }), plainStyle))

    expect(text).not.toContain(SIGNIN_SERVICES_EXTERNAL_HINT)
    expect(text).not.toContain(SIGNIN_SERVICES_DOWN_HINT)
  })

  test('keeps its footer, its busy text and its shape with the banner on it', () => {
    for (const size of SIZES) {
      const lines = render(signinModel({ services: DOWN_SERVICES, busy: true }, size), plainStyle)

      expect(lines).toHaveLength(size.rows)
      expect(lines.every((line) => line.length === size.columns)).toBe(true)
    }

    const lines = render(signinModel({ services: DOWN_SERVICES, busy: true }), plainStyle)
    expect(lines.at(-1)).toContain(SIGNIN_FOOTER)
    expect(joined(lines)).toContain(SIGNIN_BUSY_TEXT)
  })
})

/**
 * The bootstrap token file line (phase 6, F6b): while the one-time owner
 * token is still in its file, the sign-in screen says where. The path is a
 * host fact read once when the console opens, so the line is a property of
 * the screen it was opened with — a screen that follows a lost session
 * (`signedOut`) never carries it, because the sign-in that just ended is the
 * one that consumed the file.
 */
describe('render-signin: the bootstrap token file line', () => {
  const TOKEN_PATH = '/srv/mcpcut/bootstrap-token'

  test('names the file while the screen knows of one', () => {
    const text = joined(render(signinModel({ bootstrapTokenPath: TOKEN_PATH }), plainStyle))

    expect(text).toContain(`${SIGNIN_BOOTSTRAP_PREFIX}${TOKEN_PATH}`)
  })

  test('says nothing about it when there is none', () => {
    const text = joined(render(signinModel(), plainStyle))

    expect(text).not.toContain(SIGNIN_BOOTSTRAP_PREFIX)
  })

  test('sits under the services line, once status has answered', () => {
    const lines = render(
      signinModel({ services: RUNNING_SERVICES, bootstrapTokenPath: TOKEN_PATH }),
      plainStyle,
    )
    const servicesRow = lines.findIndex((line) => line.includes(SIGNIN_SERVICES_PREFIX))
    const bootstrapRow = lines.findIndex((line) => line.includes(SIGNIN_BOOTSTRAP_PREFIX))

    expect(servicesRow).toBeGreaterThanOrEqual(0)
    expect(bootstrapRow).toBe(servicesRow + 1)
  })

  test('a long path is cut at the columns rather than widening the frame', () => {
    const size: TerminalSize = { columns: 40, rows: 10 }
    const longPath = `/${'x'.repeat(60)}/bootstrap-token`

    const lines = render(signinModel({ bootstrapTokenPath: longPath }, size), plainStyle)
    const line = lines.find((each) => each.startsWith(SIGNIN_BOOTSTRAP_PREFIX))

    expect(line).toBe(padRight(`${SIGNIN_BOOTSTRAP_PREFIX}${longPath}`, size.columns))
    expect(lines.every((each) => each.length === size.columns)).toBe(true)
  })

  test('an escape sequence in the path never reaches the frame', () => {
    const text = joined(
      render(signinModel({ bootstrapTokenPath: '/tmp/\x1b[31mred/bootstrap-token' }), plainStyle),
    )

    expect(text).not.toContain('\x1b[31m')
    expect(text).toContain(SIGNIN_BOOTSTRAP_PREFIX)
  })

  test('the screen a lost session returns to does not carry it', () => {
    const before = signinModel({ bootstrapTokenPath: TOKEN_PATH })
    const after = signedOut(before.size, 'session lost', before.install)

    expect(joined(render(after, plainStyle))).not.toContain(SIGNIN_BOOTSTRAP_PREFIX)
  })

  test.each(SIZES)('keeps the frame at exactly $rows × $columns', (size) => {
    const lines = render(
      signinModel({ services: DOWN_SERVICES, bootstrapTokenPath: TOKEN_PATH }, size),
      plainStyle,
    )

    expect(lines).toHaveLength(size.rows)
    expect(lines.every((line) => line.length === size.columns)).toBe(true)
  })
})

describe('render-signin: the token-hold pane', () => {
  test('puts the banner above the output it warns about', () => {
    const lines = render(tokenHoldModel(), plainStyle)
    const firstBanner = TOKEN_HOLD_BANNER.split(' ').slice(0, 4).join(' ')

    expect(paneOf(lines[HEADER_ROWS])).toContain(firstBanner)
    expect(joined(lines)).toContain('token: mcpa_')
  })

  test('inverses the banner, and only after it has been padded', () => {
    const lines = render(tokenHoldModel(), ansiStyle)
    const pane = paneOf(lines[HEADER_ROWS])

    expect(pane.startsWith('\x1b[7m')).toBe(true)
    // The style wraps a line already padded to the pane, so what it inverses
    // is exactly the pane's width — an SGR sequence must never count as one.
    expect(pane.replace(/\x1b\[[0-9;]*m/g, '')).toHaveLength(
      DEFAULT_SIZE.columns - ACTION_COLUMN_WIDTH - COLUMN_GAP,
    )
  })

  test('leaves the verdict of the run on the last row of the pane', () => {
    const lines = render(tokenHoldModel(), plainStyle)
    const lastBodyRow = lines[DEFAULT_SIZE.rows - 2]

    expect(paneOf(lastBodyRow)).toContain(exitLine(0))
  })

  test('offers only the keys that do anything while a token is held', () => {
    const lines = render(tokenHoldModel(), plainStyle)

    expect(lines.at(-1)).toContain(TOKEN_HOLD_FOOTER)
  })

  test.each(SIZES)('is exactly $rows lines of exactly $columns columns', (size) => {
    const lines = render(tokenHoldModel(size), plainStyle)

    expect(lines).toHaveLength(size.rows)
    expect(lines.every((line) => line.length === size.columns)).toBe(true)
  })
})
