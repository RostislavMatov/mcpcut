import type { ReportManifest } from '../journal/report.js'
import type { ReportCheck, ReportVerifyResult } from '../journal/report-verify.js'

/**
 * How `verify --report` PRINTS what `journal/report-verify.ts` established
 * (M5 wave 5, task 5.3). Split out of `verify-report.ts` in the wave-5
 * review round: the checks that round added -- a summary digest, recomputed
 * counts, a required-signature mode -- pushed that file past the project's
 * 400-line cap, and formatting is the part of it with no I/O and no exit
 * codes in it.
 *
 * The output is written for someone who will paste it into a ticket. Every
 * check prints on its own line with a fixed-width marker, including the ones
 * that did NOT apply: a report that silently omits its skipped checks reads
 * as a stronger result than it is, which is the single failure mode this
 * whole command exists to avoid.
 */

/** Fixed-width status markers, so a wall of check lines scans vertically. */
const STATUS_MARKERS = {
  passed: '[PASS]   ',
  failed: '[FAIL]   ',
  'not-applicable': '[SKIPPED]',
  'could-not-run': '[NOT RUN]',
} as const

export interface RenderContext {
  readonly reportDir: string
  /** Whether `--require-signature` was in force, which changes what a clean result MEANS. */
  readonly requireSignature: boolean
}

export function renderResult(
  context: RenderContext,
  manifest: ReportManifest,
  result: ReportVerifyResult,
): string {
  return [
    headerLines(context, manifest),
    result.checks.map(checkLine).join(''),
    verdictLines(result),
    LIMITS_TEXT,
  ].join('')
}

function headerLines(context: RenderContext, manifest: ReportManifest): string {
  const scope = manifest.scope.session === null ? 'whole journal' : `session "${manifest.scope.session}"`
  const mode = context.requireSignature ? '\n  mode:       --require-signature (an unattributable export FAILS)' : ''
  return (
    'Offline report verification -- no journal database was opened.\n' +
    `  directory:  ${context.reportDir}\n` +
    `  format:     report v${manifest.formatVersion}\n` +
    `  exported:   as of ${manifest.asOf}\n` +
    `  scope:      ${scope}\n` +
    `  claims:     ${manifest.records.lineCount} record(s), ${manifest.counts.decisions} decision(s)${mode}\n\n`
  )
}

function checkLine(check: ReportCheck): string {
  return `  ${STATUS_MARKERS[check.status]} ${check.label}: ${check.detail}\n`
}

function verdictLines(result: ReportVerifyResult): string {
  const signedNote = result.signed
    ? ''
    : '\nThis export is UNSIGNED: nothing here ties it to any installation key.\n'
  if (result.failedCount > 0) {
    return (
      `\nRESULT: FAILED -- ${result.failedCount} check(s) did not hold. The bytes in this directory are ` +
      'not what the manifest describes, or the manifest is not what was signed. Treat this export as ' +
      `evidence of a discrepancy and ask the operator to account for it.${signedNote}\n`
    )
  }
  if (result.couldNotRunCount > 0) {
    return (
      `\nRESULT: INCOMPLETE -- every check that could run passed, but ${result.couldNotRunCount} could ` +
      'not run (see the NOT RUN lines above). This is not a clean bill of health: obtain what is missing ' +
      `and run it again.${signedNote}\n`
    )
  }
  return `\nRESULT: PASSED -- every check that applies to this export held.${signedNote}\n`
}

/**
 * The same honest limit `AS_OF_CONTRACT` states inside the signed bytes,
 * repeated in the command's OWN output rather than left to documentation --
 * an auditor reading a terminal must not have to go find a caveat that lives
 * somewhere else. It is the exact wording M5 uses everywhere: this is
 * tamper-EVIDENCE, and evidence only holds against an anchor kept where this
 * host cannot reach it.
 */
const LIMITS_TEXT =
  '\nWhat these checks prove: the bytes in this directory match the manifest, the counts the manifest\n' +
  'claims are the counts those bytes actually hold, and (when signed) the manifest was signed by the\n' +
  "holder of that installation's private key.\n" +
  'What they do NOT prove: that the host was never tampered with. A process running as the same user\n' +
  'that wrote the journal can rewrite it, re-export and re-sign, and the result passes every check\n' +
  'above. Detection requires comparing against an anchor recorded OUT OF BAND, somewhere that host\n' +
  'cannot also rewrite. This report also attests to history as of its "asOf" instant -- it is not a\n' +
  "statement about any subject's current rights (see the contract text in report.json).\n"
