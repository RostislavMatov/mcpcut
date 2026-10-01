import { INVALID_JSON_PREFIX, POLICY_NOT_FOUND_MESSAGE, type PolicyLoadResult } from '../policy/load.js'
import { cliCommand, shellArg } from './next-step.js'

/**
 * One line per load error, the source path once in front, and for the two
 * file-level failures what to do next: a typo'd path says to check the path,
 * broken JSON names `policy validate` with the real path. Schema errors
 * already say which field is wrong and stay as they are.
 */
export function formatPolicyLoadErrors(result: Extract<PolicyLoadResult, { status: 'error' }>): string {
  return result.errors.map((line) => `${result.sourcePath}: ${withNextStep(line, result.sourcePath)}\n`).join('')
}

function withNextStep(line: string, sourcePath: string): string {
  if (line === POLICY_NOT_FOUND_MESSAGE) {
    return `${line}. Check the path.`
  }
  if (line.startsWith(`${INVALID_JSON_PREFIX}:`)) {
    return `${line}. Check it: ${cliCommand()} policy validate ${shellArg(sourcePath)}`
  }
  return line
}
