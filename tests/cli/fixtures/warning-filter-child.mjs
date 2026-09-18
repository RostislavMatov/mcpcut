#!/usr/bin/env node
// Fixture for tests/cli/warning-filter.test.ts: proves the filter is a filter
// and not a global mute. It installs the real one (from the built `dist/`, the
// same code the binary loads), then emits both the warning that must vanish and
// one that must not. Run as a child because `process.emitWarning` and Node's
// default warning listener are process-global state.

import { installWarningFilter } from '../../../dist/cli/warning-filter.js'

installWarningFilter(process)

process.emitWarning(
  'SQLite is an experimental feature and might change at any time',
  'ExperimentalWarning',
)
process.emitWarning('a warning nobody suppressed', 'DeprecationWarning')
