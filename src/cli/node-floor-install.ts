import { nodeFloorProblem } from './node-floor.js'

/**
 * The side-effect half of `./node-floor.ts`, kept in its own module so the
 * check itself stays a pure, importable, testable function and only THIS file
 * touches the global `process`. Same shape and same reason as
 * `./warning-filter-install.ts`.
 *
 * Imported FIRST by `cli.ts`, and here being first is not decoration: ESM
 * evaluates a module's dependencies in import order, and `store/sqlite.ts`
 * reaches for `node:sqlite` while it is being evaluated. On a Node that has
 * no such builtin, any import ordered ahead of this one would throw
 * `ERR_UNKNOWN_BUILTIN_MODULE` before the message below could be printed.
 */
const problem = nodeFloorProblem(process.versions.node)
if (problem !== undefined) {
  process.stderr.write(problem)
  process.exit(1)
}
