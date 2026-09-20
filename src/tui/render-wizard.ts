import { padRight, sanitizeLine, type Style } from './ansi.js'
import {
  CONSOLE_TITLE,
  DEPLOY_INTRO,
  DEPLOY_MARKERS,
  DEPLOY_STEP_TITLES,
  DEPLOY_TITLE_WIDTH,
  FOOTER_ROWS,
  HEADER_SEPARATOR,
  ONE_TIME_TOKEN_MARKER,
  QUIT_WITH_TOKEN_QUESTION,
  RULE_CHAR,
  WIZARD_DONE_EXTERNAL_LINES,
  WIZARD_DONE_FOOTER,
  WIZARD_DONE_LINES,
  WIZARD_DONE_PARTIAL_LINES,
  WIZARD_NO_ADMIN_LINES,
  WIZARD_EXPOSURE_FOOTER,
  WIZARD_EXPOSURE_INTRO,
  WIZARD_EXPOSURE_QUESTION,
  WIZARD_FAILED_FOOTER,
  WIZARD_FORM_FOOTER,
  WIZARD_HEADER_ROWS,
  WIZARD_LABEL_WIDTH,
  WIZARD_RUNNING_FOOTER,
  WIZARD_TITLE_EDIT,
  WIZARD_TITLE_FIRST_RUN,
  WIZARD_TOKEN_FOOTER,
  WIZARD_TOKEN_QUESTION,
  mintedAdminLine,
  wizardFailedNotice,
  wizardIntroLines,
} from './constants.js'
import type {
  DeployStep,
  MintedAdmin,
  TerminalSize,
  WizardMode,
  WizardScreen,
  WizardStage,
} from './model.js'
import type { OutputPanel } from './output.js'
import { fillTo } from './layout.js'
import { outputLines } from './render-output.js'
import { fieldLines, plainPane, wrapWords } from './render-panes.js'

/**
 * The first-run wizard's frame (mcpcut phase 3, Task 5).
 *
 * The same band layout as the main screen, minus the tab bar there is no need
 * for: a title line, a rule, a body that takes what is left, and one line of
 * footer chosen by the stage. Every line is padded to `columns` BEFORE a style
 * touches it, so the invisible bytes of an SGR sequence never count as width,
 * and `render.ts` still owns the guarantee that a frame is exactly `rows`
 * lines.
 *
 * One rule is this file's alone. The owner token `setup` minted rides in the
 * model from the moment the rung finishes until the final screen shows it, and
 * ONLY the `done` stage draws it: a `deploying` frame built from a stage that
 * carries an `admin` must not contain the token, because the ladder is on
 * screen for as long as the starts take and a token drawn there would sit in
 * front of anyone walking past. `tests/tui/render-wizard.test.ts` pins it.
 */

/** Blank rows between the bands of a body: below the ladder, above a question. */
const BODY_GAP_ROWS = 3

/** The whole wizard screen, header to footer. */
export function renderWizard(
  screen: WizardScreen,
  size: TerminalSize,
  style: Style,
): readonly string[] {
  const { columns, rows } = size
  const bodyRows = Math.max(0, rows - WIZARD_HEADER_ROWS - FOOTER_ROWS)

  return [
    style.bold(padRight(`${CONSOLE_TITLE}${HEADER_SEPARATOR}${titleOf(screen.mode)}`, columns)),
    RULE_CHAR.repeat(Math.max(0, columns)),
    ...bodyOf(screen, columns, bodyRows, style),
    padRight(footerOf(screen.stage), columns),
  ]
}

function titleOf(mode: WizardMode): string {
  return mode === 'edit' ? WIZARD_TITLE_EDIT : WIZARD_TITLE_FIRST_RUN
}

function bodyOf(
  screen: WizardScreen,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  const { stage } = screen
  switch (stage.kind) {
    case 'form':
      return formBody(screen, stage.notice, width, rows, style)
    case 'confirm-exposure':
      return exposureBody(stage.warnings, width, rows)
    case 'deploying':
      return deployingBody(stage.steps, stage.output, width, rows, style)
    case 'setup-failed':
      return failedBody(stage, width, rows, style)
    case 'done':
      return doneBody(stage, width, rows, style)
  }
}

/** The keys the stage on screen answers to. */
function footerOf(stage: WizardStage): string {
  switch (stage.kind) {
    case 'form':
      return WIZARD_FORM_FOOTER
    case 'confirm-exposure':
      return WIZARD_EXPOSURE_FOOTER
    case 'deploying':
      return WIZARD_RUNNING_FOOTER
    case 'setup-failed':
      return WIZARD_FAILED_FOOTER
    case 'done':
      return stage.admin === undefined ? WIZARD_DONE_FOOTER : WIZARD_TOKEN_FOOTER
  }
}

/**
 * The questions: the intro above, the fields below, and — after a deploy that
 * came back — the notice saying why the operator is looking at them again.
 *
 * The intro is wrapped rather than cut: its first line carries the config path
 * the wizard is about to write, which is longer than 80 columns for any real
 * path (`constants.test.ts` measures the sentence with an EMPTY one), and the
 * destination of a write is the last thing to hide behind an ellipsis.
 */
function formBody(
  screen: WizardScreen,
  notice: string | undefined,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  // Sanitised BEFORE it is wrapped, not only by `padRight` afterwards: the
  // config path is interpolated into the sentence, and an escape sequence
  // left in it would count as width and move the wrap it is invisible in.
  const intro = wizardIntroLines(screen.mode, screen.configPath).flatMap((line) =>
    wrapWords(sanitizeLine(line), width),
  )
  const tail = notice === undefined ? [] : ['', notice]
  const fieldRows = Math.max(0, rows - intro.length - 1 - tail.length)

  return fillTo(
    [
      ...padded([...intro, ''], width),
      ...fieldLines(screen.form, width, fieldRows, style, WIZARD_LABEL_WIDTH),
      ...padded(tail, width),
    ],
    rows,
    width,
  )
}

/**
 * The bind confirmation, in `setup`'s own words. The warnings are wrapped at
 * spaces rather than cut, because a confirmation that loses its `[y/N]` behind
 * an ellipsis is worse than none.
 */
function exposureBody(
  warnings: readonly string[],
  width: number,
  rows: number,
): readonly string[] {
  return plainPane(
    [
      WIZARD_EXPOSURE_INTRO,
      '',
      ...warnings.flatMap((warning) => wrapWords(sanitizeLine(warning), width)),
      '',
      ...wrapWords(WIZARD_EXPOSURE_QUESTION, width),
    ],
    width,
    rows,
  )
}

/** The ladder while a rung is in flight, with the transcript of the last finished one under it. */
function deployingBody(
  steps: readonly DeployStep[],
  output: OutputPanel | undefined,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  const ladder = ladderLines(steps, width, style)
  const transcriptRows = rows - ladder.length - BODY_GAP_ROWS

  return fillTo(
    [
      ...padded([DEPLOY_INTRO, ''], width),
      ...ladder,
      ...padded([''], width),
      ...(output === undefined ? [] : outputLines(output, width, transcriptRows)),
    ],
    rows,
    width,
  )
}

/** The ladder a failed `setup` left, its transcript, and what Enter will do next. */
function failedBody(
  stage: Extract<WizardStage, { kind: 'setup-failed' }>,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  const ladder = ladderLines(stage.steps, width, style)
  const transcriptRows = rows - ladder.length - BODY_GAP_ROWS

  return fillTo(
    [
      ...ladder,
      ...padded([''], width),
      ...outputLines(stage.output, width, transcriptRows),
      ...padded(['', wizardFailedNotice(stage.output.exitCode)], width),
    ],
    rows,
    width,
  )
}

/**
 * The final screen: the ladder as it ended, what that means, and — once, and
 * only here — the owner token with the sentence telling the operator to save
 * it.
 */
function doneBody(
  stage: Extract<WizardStage, { kind: 'done' }>,
  width: number,
  rows: number,
  style: Style,
): readonly string[] {
  // The token band is measured and reserved FIRST, and everything else is
  // given what is left. A token is shown once and cannot be shown again, so
  // on a terminal too short for all three bands it is the summary that goes,
  // then the ladder — never the secret or the question that guards it. At
  // the smallest terminal the console runs on (`MIN_COLUMNS`/`MIN_ROWS`) the
  // band alone is the whole body.
  const token = padded(tokenLines(stage.admin, stage.quitAsked, width), width)
  const head = [
    ...ladderLines(stage.steps, width, style),
    ...padded(['', ...doneLines(stage.steps), '', ...noAdminLines(stage.admin)], width),
  ]

  return fillTo(
    [...fillTo(head, Math.max(0, rows - token.length), width), ...token],
    rows,
    width,
  )
}

/** What the deploy amounted to: everything up, something down, or nothing started from here. */
function doneLines(steps: readonly DeployStep[]): readonly string[] {
  const starts = steps.filter((step) => step.id !== 'setup')
  if (starts.length > 0 && starts.every((step) => step.state === 'skipped')) {
    return WIZARD_DONE_EXTERNAL_LINES
  }
  if (steps.some((step) => step.state === 'failed')) return WIZARD_DONE_PARTIAL_LINES

  return WIZARD_DONE_LINES
}

/** Why there is no token to save: only when this run minted nobody, and instead of the band. */
function noAdminLines(admin: MintedAdmin | undefined): readonly string[] {
  return admin === undefined ? [...WIZARD_NO_ADMIN_LINES, ''] : []
}

/** The one place a token reaches a frame; nothing at all when this run minted none. */
export function tokenLines(
  admin: MintedAdmin | undefined,
  quitAsked: boolean,
  width: number,
  savedQuestion: string = WIZARD_TOKEN_QUESTION,
): readonly string[] {
  if (admin === undefined) return []

  const question = quitAsked ? QUIT_WITH_TOKEN_QUESTION : savedQuestion

  return [
    ...tokenHeadLines(admin, width),
    ONE_TIME_TOKEN_MARKER,
    '',
    ...wrapWords(question, width),
  ]
}

/**
 * The label and the token on one line where they fit, on separate lines where
 * they do not.
 *
 * They do not fit at 80 columns: an admin token is 48 characters (32 random
 * bytes in base64url after `mcpa_`) and the shortest label `mintedAdminLine`
 * writes is 38, so a single line would be cut — and a token shown ONCE that
 * ends in an ellipsis is gone, since nothing can show it again. Even alone the
 * token is longer than a narrow terminal, so it is cut into rows rather than
 * into an ellipsis; there is no space in it to wrap at.
 */
function tokenHeadLines(admin: MintedAdmin, width: number): readonly string[] {
  const label = mintedAdminLine(admin.name)
  if (label.length + admin.token.length <= width) return [`${label}${admin.token}`]

  return [label.trimEnd(), ...brokenAt(admin.token, width)]
}

/** A string with nothing to wrap at, in rows of `width`. */
function brokenAt(text: string, width: number): readonly string[] {
  if (width <= 0) return [text]

  return Array.from({ length: Math.ceil(text.length / width) }, (_row, index) =>
    text.slice(index * width, (index + 1) * width),
  )
}

/**
 * One line per rung: the marker of its state, the title in a column of its
 * own, and the detail the command left. The style goes on AFTER the padding,
 * so a dimmed rung is still exactly `width` characters of visible text.
 */
function ladderLines(
  steps: readonly DeployStep[],
  width: number,
  style: Style,
): readonly string[] {
  return steps.map((step) => {
    const title = DEPLOY_STEP_TITLES[step.id].padEnd(DEPLOY_TITLE_WIDTH)
    const line = padRight(`${DEPLOY_MARKERS[step.state]} ${title}${step.detail ?? ''}`, width)
    if (step.state === 'running') return style.bold(line)

    return step.state === 'done' || step.state === 'failed' ? line : style.dim(line)
  })
}

/** Text lines made frame lines: sanitised, fitted and padded to the body's width. */
function padded(lines: readonly string[], width: number): readonly string[] {
  return lines.map((line) => padRight(line, width))
}
