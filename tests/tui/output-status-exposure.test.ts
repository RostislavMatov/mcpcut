import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { dispatch } from '../../src/cli.js'
import type { ServiceName } from '../../src/services/constants.js'
import type { ServiceManager, ServiceStatus } from '../../src/services/manager.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { SERVICES_SECTION } from '../../src/tui/catalogue/services.js'
import type { RunRequest } from '../../src/tui/model.js'
import { outputPanelOf, STDERR_SEPARATOR } from '../../src/tui/output.js'
import { executeEffect } from '../../src/tui/runtime-effects.js'
import {
  baseOptions,
  depsOf,
  disposeEffectsJournalDir,
  openEffectsJournalDir,
  runResultOf,
  signedInCell,
} from './support/effects-harness.js'

/**
 * What the console panel shows for `Services ▸ status` on an install whose ui
 * binds the network (Q31). The console runs the TABLE form of `status`, so
 * the exposure warning `runStatus` writes to stderr lands in the panel under
 * `— stderr —` — on purpose: the plan's answer to "where does the console
 * show the warning" is "in `Services ▸ status`, because it is the same
 * output". `--json` stays clean, because the header parses it.
 *
 * The whole path is real — the catalogue's argv, the `run` effect, `dispatch`
 * and `runServiceCommand` — except the manager, which answers from a script
 * so no daemon has to listen on `0.0.0.0`.
 */

const DATA_DIR = '/tmp/mcpcut-output-status-exposure'
const EXPOSURE_DETAIL = 'ui binds 0.0.0.0: reachable from the network. — ADR-0004'

const STATUSES: Readonly<Record<ServiceName, ServiceStatus>> = {
  ui: {
    service: 'ui',
    state: 'running',
    pid: 1,
    host: '0.0.0.0',
    port: 8091,
    logPath: `${DATA_DIR}/run/ui.log`,
    exposure: { level: 'warn', detail: EXPOSURE_DETAIL },
  },
  serve: {
    service: 'serve',
    state: 'running',
    pid: 2,
    host: '127.0.0.1',
    port: 8090,
    logPath: `${DATA_DIR}/run/serve.log`,
  },
}

const SCRIPTED_MANAGER: ServiceManager = {
  start: async () => {
    throw new Error('status must not start anything')
  },
  stop: async () => {
    throw new Error('status must not stop anything')
  },
  status: async (service) => STATUSES[service],
  logs: async () => [],
}

function statusRequest(): RunRequest {
  const action = SERVICES_SECTION.actions.find((each) => each.id === 'status')
  if (action === undefined) throw new Error('no status action in the Services section')
  const argv = action.argv({})
  return { actionId: 'services.status', argv, display: argv }
}

async function panelLinesOf(request: RunRequest): Promise<readonly string[]> {
  const { cell } = await signedInCell()
  const deps = depsOf(dispatch, cell)
  const message = await executeEffect(
    { kind: 'run', request },
    {
      ...deps,
      dispatchOptions: {
        ...baseOptions(),
        services: {
          install: { kind: 'ok', path: `${DATA_DIR}/config.json`, config: defaultInstallConfig(DATA_DIR) },
          manager: SCRIPTED_MANAGER,
        },
      },
    },
  )
  return outputPanelOf(runResultOf(message).result).lines
}

beforeEach(openEffectsJournalDir)
afterEach(disposeEffectsJournalDir)

describe('Services ▸ status with a ui reachable from the network (Q31)', () => {
  test('the panel shows the table, then the warning under the stderr separator', async () => {
    const lines = await panelLinesOf(statusRequest())

    expect(lines).toEqual([
      'ui     running  pid 1  0.0.0.0:8091    —',
      'serve  running  pid 2  127.0.0.1:8090  —',
      STDERR_SEPARATOR,
      `ui:    warning: ${EXPOSURE_DETAIL}`,
    ])
  })

  test('status --json, which the header parses, carries no stderr section', async () => {
    const lines = await panelLinesOf({
      actionId: 'services.status',
      argv: ['status', '--json'],
      display: ['status', '--json'],
    })

    expect(lines.join('\n')).toContain(`"detail":"${EXPOSURE_DETAIL}"`)
    expect(lines).not.toContain(STDERR_SEPARATOR)
  })
})
