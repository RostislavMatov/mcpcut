import { describe, expect, test } from 'vitest'
import { ansiStyle, padRight, plainStyle, sanitizeLine } from '../../src/tui/ansi.js'
import {
  CARET,
  CONSOLE_TITLE,
  DEPLOY_EXTERNAL_DETAIL,
  DEPLOY_INTRO,
  DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL,
  deployExitDetail,
  deployWaitingDetail,
  HEADER_SEPARATOR,
  ONE_TIME_TOKEN_MARKER,
  QUIT_WITH_TOKEN_QUESTION,
  RULE_CHAR,
  WIZARD_DONE_FOOTER,
  WIZARD_NO_ADMIN_LINES,
  WIZARD_EXPOSURE_FOOTER,
  WIZARD_EXPOSURE_INTRO,
  WIZARD_EXPOSURE_QUESTION,
  WIZARD_FAILED_FOOTER,
  WIZARD_FORM_FOOTER,
  WIZARD_LABEL_WIDTH,
  WIZARD_RUNNING_FOOTER,
  WIZARD_TITLE_EDIT,
  WIZARD_TITLE_FIRST_RUN,
  WIZARD_TOKEN_FOOTER,
  WIZARD_TOKEN_QUESTION,
  mintedAdminLine,
  wizardFailedNotice,
  wizardIntroLines,
} from '../../src/tui/constants.js'
import type {
  DeployStep,
  DeployStepId,
  DeployStepState,
  Model,
  TerminalSize,
  WizardMode,
  WizardScreen,
  WizardStage,
} from '../../src/tui/model.js'
import { outputPanelOf, type OutputPanel } from '../../src/tui/output.js'
import { render } from '../../src/tui/render.js'
import { fieldLines, wrapWords } from '../../src/tui/render-panes.js'
import { renderWizard } from '../../src/tui/render-wizard.js'
import { wizardScreenOf } from '../../src/tui/wizard-fields.js'
import { START_READY_TIMEOUT_MS } from '../../src/services/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'

/**
 * The wizard's frame (mcpcut phase 3, Task 5). Like the rest of the render
 * layer this is a shape contract first — exactly `rows` lines of exactly
 * `columns`, at every size — and a content contract second.
 *
 * The one invariant worth naming: the owner token exists in the model from the
 * moment `setup` mints it, but only the `done` stage draws it. A `deploying`
 * frame built from a stage that carries an `admin` must not contain it, and
 * the test below is what keeps that true.
 */

const CONFIG_PATH = '/home/op/.mcpcut/config.json'
const DATA_DIR = '/var/lib/x'

const SIZES: readonly TerminalSize[] = [
  { columns: 80, rows: 24 },
  { columns: 40, rows: 10 },
  // The short terminal the token band has to survive: a 14-row window leaves
  // 11 body rows, which the ladder and the summary would spend on their own.
  { columns: 80, rows: 14 },
  { columns: 200, rows: 50 },
]

const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 }

function wizardBase(mode: WizardMode = 'first-run'): WizardScreen {
  return wizardScreenOf({ mode, configPath: CONFIG_PATH, config: defaultInstallConfig(DATA_DIR) })
}

function screenOf(stage: WizardStage, mode: WizardMode = 'first-run'): WizardScreen {
  return { ...wizardBase(mode), stage }
}

function frame(stage: WizardStage, size: TerminalSize = DEFAULT_SIZE): readonly string[] {
  return renderWizard(screenOf(stage), size, plainStyle)
}

function joined(lines: readonly string[]): string {
  return lines.join('\n')
}

function text(stage: WizardStage, size: TerminalSize = DEFAULT_SIZE): string {
  return joined(frame(stage, size))
}

function stripSgr(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '')
}

function step(id: DeployStepId, state: DeployStepState, detail?: string): DeployStep {
  return { id, state, ...(detail !== undefined ? { detail } : {}) }
}

function panelOf(
  argv: readonly string[],
  stdout: string,
  exitCode = 0,
): OutputPanel {
  return outputPanelOf({ argv, display: [...argv], exitCode, stdout, stderr: '' })
}

const SETUP_ARGV: readonly string[] = ['setup', '--yes', '--data-dir', DATA_DIR]

const SETUP_TRANSCRIPT = [
  'check  data dir       ok   /var/lib/x (0700)',
  'check  ui bind        ok   127.0.0.1:8091 free',
  'setup: config written to /home/op/.mcpcut/config.json',
].join('\n')

const FAILED_TRANSCRIPT = [
  'check  data dir       ok   /var/lib/x (0700)',
  'check  ui bind        fail ui: cannot bind 127.0.0.1:8091: address already in use',
].join('\n')

const EXPOSURE_WARNING =
  'ui binds 0.0.0.0: reachable from the network. Terminate TLS in front (ui: ' +
  "--behind-tls + --allowed-host; serve: agents' bearer tokens travel in clear " +
  'otherwise) — ADR-0004'

const WAITING_DETAIL = deployWaitingDetail(START_READY_TIMEOUT_MS)

const DEPLOYING_STAGE: WizardStage = {
  kind: 'deploying',
  steps: [
    step('setup', 'done', DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL),
    step('start-ui', 'running', WAITING_DETAIL),
    step('start-serve', 'pending'),
  ],
  output: panelOf(SETUP_ARGV, SETUP_TRANSCRIPT),
  admin: { name: 'owner', token: 'mcpa_secret' },
}

const FAILED_STAGE: WizardStage = {
  kind: 'setup-failed',
  steps: [
    step('setup', 'failed', deployExitDetail(1)),
    step('start-ui', 'pending'),
    step('start-serve', 'pending'),
  ],
  output: panelOf(SETUP_ARGV, FAILED_TRANSCRIPT, 1),
}

function doneStage(patch: {
  readonly steps?: readonly DeployStep[]
  readonly admin?: { readonly name: string; readonly token: string }
  readonly quitAsked?: boolean
}): WizardStage {
  return {
    kind: 'done',
    steps: patch.steps ?? [
      step('setup', 'done', DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL),
      step('start-ui', 'done', 'ui:    started pid 4242 on http://127.0.0.1:8091/'),
      step('start-serve', 'done', 'serve: started pid 4243 on http://127.0.0.1:8090/'),
    ],
    ...(patch.admin !== undefined ? { admin: patch.admin } : {}),
    quitAsked: patch.quitAsked ?? false,
  }
}

const EXTERNAL_STEPS: readonly DeployStep[] = [
  step('setup', 'done', DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL),
  step('start-ui', 'skipped', DEPLOY_EXTERNAL_DETAIL),
  step('start-serve', 'skipped', DEPLOY_EXTERNAL_DETAIL),
]

const PARTIAL_STEPS: readonly DeployStep[] = [
  step('setup', 'done', DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL),
  step('start-ui', 'failed', 'ui: did not answer in time'),
  step('start-serve', 'done', 'serve: started pid 4243 on http://127.0.0.1:8090/'),
]

const STAGES: readonly (readonly [string, WizardStage])[] = [
  ['form', { kind: 'form' }],
  ['form with a notice', { kind: 'form', notice: wizardFailedNotice(1) }],
  [
    'confirm-exposure',
    {
      kind: 'confirm-exposure',
      request: { actionId: 'setup', argv: [...SETUP_ARGV], display: [...SETUP_ARGV] },
      warnings: [EXPOSURE_WARNING],
    },
  ],
  ['deploying', DEPLOYING_STAGE],
  ['setup-failed', FAILED_STAGE],
  ['done', doneStage({ admin: { name: 'owner', token: 'mcpa_x' } })],
  ['done without an admin', doneStage({})],
]

describe('renderWizard: the shape of a frame', () => {
  for (const size of SIZES) {
    for (const [name, stage] of STAGES) {
      test(`${name} is exactly ${size.rows} lines of exactly ${size.columns} columns`, () => {
        const lines = frame(stage, size)

        expect(lines).toHaveLength(size.rows)
        expect(lines.every((line) => line.length === size.columns)).toBe(true)
      })
    }
  }

  test('the header is the console title, the mode and a rule', () => {
    const lines = frame({ kind: 'form' })

    expect(lines[0]).toBe(
      padRight(`${CONSOLE_TITLE}${HEADER_SEPARATOR}${WIZARD_TITLE_FIRST_RUN}`, DEFAULT_SIZE.columns),
    )
    expect(lines[1]).toBe(RULE_CHAR.repeat(DEFAULT_SIZE.columns))
  })

  test('the edit mode names itself in the header', () => {
    const lines = renderWizard(screenOf({ kind: 'form' }, 'edit'), DEFAULT_SIZE, plainStyle)

    expect(lines[0]).toContain(WIZARD_TITLE_EDIT)
  })

  test('a styled frame is the plain frame plus invisible bytes', () => {
    for (const [, stage] of STAGES) {
      const styled = renderWizard(screenOf(stage), DEFAULT_SIZE, ansiStyle)

      expect(styled.map(stripSgr)).toEqual(frame(stage))
    }
  })
})

describe('renderWizard: the form stage', () => {
  test('shows the intro, every field and the form footer', () => {
    const lines = frame({ kind: 'form' })
    const body = joined(lines)

    for (const line of wizardIntroLines('first-run', CONFIG_PATH)) {
      for (const wrapped of wrapWords(line, DEFAULT_SIZE.columns)) {
        expect(body).toContain(wrapped)
      }
    }
    expect(body).toContain(CONFIG_PATH)
    expect(body).toContain('Data dir')
    expect(body).toContain(`[${DATA_DIR}${CARET}]`)
    expect(body).toContain('‹ mcpcut ›')
    expect(body).toContain('[ ]')
    expect(lines.at(-1)).toBe(padRight(WIZARD_FORM_FOOTER, DEFAULT_SIZE.columns))
  })

  test('shows the notice a failed deploy came back with', () => {
    expect(text({ kind: 'form', notice: wizardFailedNotice(1) })).toContain(wizardFailedNotice(1))
  })
})

describe('renderWizard: the exposure confirmation', () => {
  const stage: WizardStage = {
    kind: 'confirm-exposure',
    request: { actionId: 'setup', argv: [...SETUP_ARGV], display: [...SETUP_ARGV] },
    warnings: [EXPOSURE_WARNING],
  }

  test('states the warning whole and asks its question unclipped at 80 columns', () => {
    const lines = frame(stage)
    const body = joined(lines)

    expect(body).toContain(WIZARD_EXPOSURE_INTRO)
    for (const wrapped of wrapWords(EXPOSURE_WARNING, DEFAULT_SIZE.columns)) {
      expect(body).toContain(wrapped)
    }
    expect(body).toContain('ADR-0004')
    expect(body).toContain(WIZARD_EXPOSURE_QUESTION)
    expect(lines.at(-1)).toBe(padRight(WIZARD_EXPOSURE_FOOTER, DEFAULT_SIZE.columns))
  })
})

describe('renderWizard: the deploy ladder', () => {
  test('marks each rung and shows the transcript of the last finished step', () => {
    const lines = frame(DEPLOYING_STAGE)
    const body = joined(lines)

    expect(body).toContain(DEPLOY_INTRO)
    expect(body).toContain('✓ Checks and config')
    expect(body).toContain('… Starting ui')
    expect(body).toContain('Starting serve')
    expect(body).toContain('waiting for the service')
    expect(body).toContain('check  data dir')
    expect(lines.at(-1)).toBe(padRight(WIZARD_RUNNING_FOOTER, DEFAULT_SIZE.columns))
  })

  test('never draws the token the stage carries between the rungs', () => {
    for (const size of SIZES) {
      expect(text(DEPLOYING_STAGE, size)).not.toContain('mcpa_')
    }
  })

  test('keeps the ladder when the terminal has no room for a transcript', () => {
    expect(text(DEPLOYING_STAGE, { columns: 40, rows: 10 })).toContain('Checks and config')
  })
})

describe('renderWizard: a setup that did not complete', () => {
  test('marks the rung failed, keeps the transcript and says what to do', () => {
    const lines = frame(FAILED_STAGE)
    const body = joined(lines)

    expect(body).toContain('✗ Checks and config')
    expect(body).toContain('check  ui bind')
    expect(body).toContain('Setup did not complete')
    expect(lines.at(-1)).toBe(padRight(WIZARD_FAILED_FOOTER, DEFAULT_SIZE.columns))
  })
})

describe('renderWizard: the final screen', () => {
  test('shows the owner token once, with the notice and the question', () => {
    const lines = frame(doneStage({ admin: { name: 'owner', token: 'mcpa_x' } }))
    const body = joined(lines)

    expect(body).toContain('Owner token for "owner" (shown once): mcpa_x')
    expect(body).toContain(ONE_TIME_TOKEN_MARKER)
    expect(body).toContain(WIZARD_TOKEN_QUESTION)
    expect(body).toContain('Setup complete.')
    expect(lines.at(-1)).toBe(padRight(WIZARD_TOKEN_FOOTER, DEFAULT_SIZE.columns))
  })

  test('keeps a real token whole at 80 columns, on its own line if it must', () => {
    // 32 random bytes in base64url plus the `mcpa_` prefix: 48 characters, which
    // the label of `mintedAdminLine` cannot share an 80-column line with.
    const token = `mcpa_${'a'.repeat(43)}`
    const lines = frame(doneStage({ admin: { name: 'owner', token } }))

    expect(joined(lines)).toContain(token)
    expect(joined(lines)).toContain(mintedAdminLine('owner').trimEnd())
  })

  test('asks about the token again when q was pressed with it on screen', () => {
    const body = text(doneStage({ admin: { name: 'owner', token: 'mcpa_x' }, quitAsked: true }))

    for (const wrapped of wrapWords(QUIT_WITH_TOKEN_QUESTION, DEFAULT_SIZE.columns)) {
      expect(body).toContain(wrapped)
    }
    expect(body).not.toContain(WIZARD_TOKEN_QUESTION)
  })

  test('offers Enter instead of y when this run minted no admin', () => {
    const lines = frame(doneStage({}))

    expect(joined(lines)).not.toContain('Owner token for')
    expect(lines.at(-1)).toBe(padRight(WIZARD_DONE_FOOTER, DEFAULT_SIZE.columns))
  })

  test('says why there is no token when this run minted no admin', () => {
    // The only way `setup` mints nobody is a data directory that already
    // had admins: the owner who ran the wizard over an existing install must
    // read that here, not deduce it from a missing word on the ladder.
    const body = text(doneStage({}))

    for (const line of WIZARD_NO_ADMIN_LINES) expect(body).toContain(line)
    expect(body).toContain('admin rotate <name> --recover')
  })

  test('does not explain a missing token when the token is on screen', () => {
    const body = text(doneStage({ admin: { name: 'owner', token: 'mcpa_x' } }))

    for (const line of WIZARD_NO_ADMIN_LINES) expect(body).not.toContain(line)
  })

  test('says the services belong elsewhere when both starts were skipped', () => {
    expect(text(doneStage({ steps: EXTERNAL_STEPS }))).toContain('supervisor: external')
  })

  test('says not everything started when a rung failed', () => {
    expect(text(doneStage({ steps: PARTIAL_STEPS }))).toContain('Not every service started')
  })
})

describe('renderWizard: the final screen holds the token at every size', () => {
  // 32 random bytes in base64url after `mcpa_`: what a real owner token
  // measures. The short token of the tests above fits anywhere and would
  // never show the band being squeezed out.
  const TOKEN = `mcpa_${'a'.repeat(43)}`

  /** The frame read as one string, with the row breaks the token was cut at removed. */
  function unwrapped(lines: readonly string[]): string {
    return lines.join('')
  }

  for (const size of SIZES) {
    test(`the token, the question and the footer survive ${size.columns}x${size.rows}`, () => {
      const lines = frame(doneStage({ admin: { name: 'owner', token: TOKEN } }), size)

      expect(unwrapped(lines)).toContain(TOKEN)
      for (const wrapped of wrapWords(WIZARD_TOKEN_QUESTION, size.columns)) {
        expect(joined(lines)).toContain(wrapped)
      }
      expect(lines.at(-1)).toBe(padRight(WIZARD_TOKEN_FOOTER, size.columns))
      // The shape contract still holds: the band is reserved, not appended.
      expect(lines).toHaveLength(size.rows)
      expect(lines.every((line) => line.length === size.columns)).toBe(true)
    })
  }

  test('the ladder is what gives way first, and only once the summary has', () => {
    const stage = doneStage({ admin: { name: 'owner', token: TOKEN } })

    expect(text(stage, { columns: 80, rows: 24 })).toContain('Setup complete.')
    // 14 rows leave 11 for the body, which the ladder and the summary would
    // spend on their own; the summary goes and the ladder stays.
    expect(text(stage, { columns: 80, rows: 14 })).toContain('Checks and config')
  })
})

describe('renderWizard: interpolated text is sanitised before it is wrapped', () => {
  const ESCAPE = '\x1b[31m'
  /** A path an install could really be given, plus bytes no terminal may see. */
  const HOSTILE_PATH = `/tmp/${ESCAPE}c\rf.json`
  const CLEAN_PATH = sanitizeLine(HOSTILE_PATH)

  function formFrame(configPath: string): readonly string[] {
    const screen = wizardScreenOf({
      mode: 'first-run',
      configPath,
      config: defaultInstallConfig(DATA_DIR),
    })

    return renderWizard(screen, DEFAULT_SIZE, plainStyle)
  }

  test('a config path carrying an escape wraps exactly as its sanitised twin', () => {
    const clean = formFrame(CLEAN_PATH)

    // The precondition: the sanitised intro fits one row, so a wrap that
    // counted the invisible bytes would be visible as a second row.
    expect(joined(clean)).toContain(wizardIntroLines('first-run', CLEAN_PATH)[0] ?? '')
    expect(formFrame(HOSTILE_PATH)).toEqual(clean)
    expect(joined(formFrame(HOSTILE_PATH))).not.toContain('\x1b')
    expect(joined(formFrame(HOSTILE_PATH))).not.toContain('\r')
  })

  test('an exposure warning carrying an escape wraps exactly as its sanitised twin', () => {
    const hostile = `${'w'.repeat(75)} ${ESCAPE}tail`
    const stageOf = (warning: string): WizardStage => ({
      kind: 'confirm-exposure',
      request: { actionId: 'setup', argv: [...SETUP_ARGV], display: [...SETUP_ARGV] },
      warnings: [warning],
    })

    expect(frame(stageOf(hostile))).toEqual(frame(stageOf(sanitizeLine(hostile))))
  })
})

describe('render: the route to the wizard', () => {
  test('renders the wizard screen through the console renderer', () => {
    const model: Model = { screen: screenOf({ kind: 'form' }), size: DEFAULT_SIZE }

    const lines = render(model, plainStyle)

    expect(lines).toHaveLength(DEFAULT_SIZE.rows)
    expect(joined(lines)).toContain(WIZARD_TITLE_FIRST_RUN)
  })
})

describe('fieldLines: the shared field renderer', () => {
  const form = wizardBase().form

  test('a wider label column does not shift the widget', () => {
    const lines = fieldLines(form, 80, form.fields.length, plainStyle, WIZARD_LABEL_WIDTH)
    const dataDir = lines[0] ?? ''
    const supervisor = lines.at(-1) ?? ''

    expect(dataDir).toContain('Data dir')
    expect(supervisor).toContain('Services by')
    expect(dataDir.indexOf('[')).toBe(supervisor.indexOf('‹'))
  })

  test('the default label column is narrower than the wizard asks for', () => {
    const wide = fieldLines(form, 80, form.fields.length, plainStyle, WIZARD_LABEL_WIDTH)
    const narrow = fieldLines(form, 80, form.fields.length, plainStyle)

    expect((narrow[0] ?? '').indexOf('[')).toBeLessThan((wide[0] ?? '').indexOf('['))
  })

  test('returns one line per field, every line exactly the width asked for', () => {
    const lines = fieldLines(form, 40, form.fields.length, plainStyle, WIZARD_LABEL_WIDTH)

    expect(lines).toHaveLength(form.fields.length)
    expect(lines.every((line) => line.length === 40)).toBe(true)
  })

  test('yields nothing when there is no room for a field', () => {
    expect(fieldLines(form, 80, 0, plainStyle, WIZARD_LABEL_WIDTH)).toEqual([])
    expect(fieldLines(form, 80, -3, plainStyle, WIZARD_LABEL_WIDTH)).toEqual([])
  })
})
