import { installWarningFilter } from './warning-filter.js'

/**
 * The side-effect half of `./warning-filter.ts`, kept in its own module so the
 * filter itself stays a pure, importable, testable function and only THIS file
 * touches the global `process`.
 *
 * Imported first by `cli.ts`, though it need not be: the warning is printed by
 * a `process.nextTick` callback, so any top-level statement of the entry runs
 * in time. Being first costs nothing and keeps the intent visible.
 */
installWarningFilter(process)
