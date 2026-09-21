/**
 * The runtime floor, as one line an operator can act on.
 *
 * `mcpcut` used to run only where someone had installed it on purpose. Since
 * `connect --url` (ADR-0015) it also runs on an agent's machine, launched by
 * that agent's client config, on whatever Node that machine happens to have.
 * Below the floor the first import of `store/sqlite.ts` throws
 * `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` with a stack and no advice — and
 * an MCP client shows the operator exactly that.
 *
 * This module is a pure function on purpose, and a LEAF on purpose: it
 * imports nothing at all (not even `../config.js` for a version constant, and
 * not `package.json#engines`, which would mean file IO before the check), and
 * uses no syntax newer than ES2022 — an old Node must be able to PARSE and
 * evaluate this module in order to be told it is too old. The side-effect
 * half lives in `./node-floor-install.ts`, the `warning-filter.ts` precedent.
 */

/** Node 24 LTS is the floor recorded in ADR-0006 (`node:sqlite`, `--experimental-*` off). */
export const MIN_NODE_MAJOR = 24

/** `24.13.3` / `v24.13.3` → `24`; anything else → `undefined`. */
function majorOf(nodeVersion: string): number | undefined {
  const digits = /^v?(\d+)\./.exec(nodeVersion)?.[1]
  if (digits === undefined) return undefined
  const major = Number.parseInt(digits, 10)
  return Number.isNaN(major) ? undefined : major
}

/**
 * The one line to print before this runtime fails at something it cannot
 * explain, or `undefined` when the runtime is new enough.
 *
 * An unparseable version string answers `undefined` too: a runtime that
 * reports its version in a shape this function does not know is not thereby
 * proven old, and refusing to start over a strange string would be the worse
 * failure of the two.
 */
export function nodeFloorProblem(nodeVersion: string): string | undefined {
  const major = majorOf(nodeVersion)
  if (major === undefined || major >= MIN_NODE_MAJOR) return undefined

  return (
    `mcpcut needs Node ${MIN_NODE_MAJOR} or newer (this is v${nodeVersion.replace(/^v/, '')}). ` +
    'Install a current Node and run the command again.\n'
  )
}
