import { describe, expect, test } from 'vitest'
import { SIGKILL_ESCALATION_MS } from '../../src/config.js'
import {
  LOG_TAIL_DEFAULT_LINES,
  SERVICE_NAMES,
  START_READY_TIMEOUT_MS,
} from '../../src/services/constants.js'
import {
  meetsRequirement,
  refreshActionOf,
  SECTIONS,
  visibleActions,
  visibleSections,
} from '../../src/tui/catalogue/index.js'
import { SERVICES_SECTION } from '../../src/tui/catalogue/services.js'
import type { ActionSpec, SectionSpec } from '../../src/tui/catalogue/types.js'
import { DEFAULT_INSTALL_FACTS, type InstallFacts } from '../../src/tui/model.js'

/**
 * The Services section (mcpcut phase 5, Task 3): `status|start|stop|logs` over
 * this install's own daemons, plus `setup`, the one action that leaves the
 * console rather than dispatching.
 *
 * Two things are load-bearing here and nowhere else. The argv each action
 * builds is the argv the shell would run — `start` with no service means BOTH,
 * in the order `service-cmd-args.ts` fixes — and the visibility rule that
 * hides `start`/`stop` on an install somebody else supervises: `meetsRequirement`
 * is what makes a menu offer only what the install can do, and `visibleSections`
 * must take nothing else away while it does it.
 */

const EXTERNAL_FACTS: InstallFacts = { supervisor: 'external' }
const REMOTE_FACTS: InstallFacts = { supervisor: 'mcpcut', remote: true }

function actionOf(id: string): ActionSpec {
  const action = SERVICES_SECTION.actions.find((each) => each.id === id)
  if (action === undefined) throw new Error(`no action "${id}" in the Services section`)

  return action
}

function servicesOf(sections: readonly SectionSpec[]): SectionSpec {
  const section = sections.find((each) => each.id === 'services')
  if (section === undefined) throw new Error('no Services section in the list')

  return section
}

describe('the Services section takes its place in the catalogue', () => {
  test('it is the twelfth and last tab, and it refreshes itself with status', () => {
    expect(SECTIONS[SECTIONS.length - 1]).toBe(SERVICES_SECTION)
    expect(SERVICES_SECTION.id).toBe('services')
    expect(SERVICES_SECTION.refreshActionId).toBe('status')
  })

  test('its five actions are in the order an operator meets them', () => {
    expect(SERVICES_SECTION.actions.map((action) => action.id)).toEqual([
      'status',
      'start',
      'stop',
      'logs',
      'setup',
    ])
  })
})

describe('the argv of the Services section', () => {
  test('status asks for the whole table', () => {
    expect(actionOf('status').argv({})).toEqual(['status'])
  })

  test('start names one service, or none at all when both are wanted', () => {
    const start = actionOf('start')

    expect(start.argv({ service: 'both' })).toEqual(['start'])
    expect(start.argv({ service: 'ui' })).toEqual(['start', 'ui'])
    expect(start.argv({ service: 'serve' })).toEqual(['start', 'serve'])
  })

  test('stop reads the same way, and offers the CLI’s own stop order first', () => {
    const stop = actionOf('stop')

    expect(stop.argv({ service: 'both' })).toEqual(['stop'])
    expect(stop.argv({ service: 'serve' })).toEqual(['stop', 'serve'])
    expect(stop.fields[0]?.options).toEqual(['both', ...[...SERVICE_NAMES].reverse()])
    expect(actionOf('start').fields[0]?.options).toEqual(['both', ...SERVICE_NAMES])
  })

  test('logs names the service and passes --lines only when one is typed', () => {
    const logs = actionOf('logs')

    expect(logs.argv({ service: 'ui', lines: '' })).toEqual(['logs', 'ui'])
    expect(logs.argv({ service: 'serve', lines: '20' })).toEqual([
      'logs',
      'serve',
      '--lines',
      '20',
    ])
    expect(logs.fields[0]?.options).toEqual([...SERVICE_NAMES])
  })

  test('setup runs the wizard’s own command and nothing else', () => {
    expect(actionOf('setup').argv({})).toEqual(['setup'])
  })
})

describe('the fields of the Services section', () => {
  test('the lines field takes a positive whole number, or nothing', () => {
    const lines = actionOf('logs').fields.find((field) => field.name === 'lines')

    expect(lines?.validate?.('50')).toBeUndefined()
    expect(lines?.validate?.('')).toBeUndefined()
    expect(lines?.validate?.('0')).toBeDefined()
    expect(lines?.validate?.('abc')).toBeDefined()
    expect(lines?.validate?.('-1')).toBeDefined()
  })

  test('the hints quote the numbers the commands really use', () => {
    expect(actionOf('start').hint).toContain(`${START_READY_TIMEOUT_MS / 1000} s`)
    expect(actionOf('stop').hint).toContain(`${SIGKILL_ESCALATION_MS / 1000} s`)
    expect(
      actionOf('logs').fields.find((field) => field.name === 'lines')?.hint,
    ).toContain(String(LOG_TAIL_DEFAULT_LINES))
  })
})

describe('the actions that interrupt something ask first', () => {
  test('stop names what is about to go down', () => {
    const stop = actionOf('stop')

    expect(stop.confirm?.({ service: 'both' })).toContain('ui and serve')
    expect(stop.confirm?.({ service: 'both' })).toContain('?')
    expect(stop.confirm?.({ service: 'ui' })).toContain('ui')
  })

  test('start does not: bringing a daemon up destroys nothing', () => {
    expect(actionOf('start').confirm).toBeUndefined()
  })

  test('setup asks before it takes the terminal away, and carries no form', () => {
    const setup = actionOf('setup')

    expect(setup.leavesConsole).toBe(true)
    expect(setup.fields).toEqual([])
    expect(setup.confirm?.({})).toContain('?')
  })
})

describe('who is shown what', () => {
  test('a viewer is offered reading the table and nothing else', () => {
    expect(visibleActions(SERVICES_SECTION, 'viewer').map((action) => action.id)).toEqual([
      'status',
    ])
  })

  test('an operator may drive the daemons; only an owner is offered setup', () => {
    expect(visibleActions(SERVICES_SECTION, 'operator').map((action) => action.id)).toEqual([
      'status',
      'start',
      'stop',
      'logs',
    ])
    expect(visibleActions(SERVICES_SECTION, 'owner').map((action) => action.id)).toEqual([
      'status',
      'start',
      'stop',
      'logs',
      'setup',
    ])
  })
})

describe('an install somebody else supervises is offered less', () => {
  test('meetsRequirement answers for one action at a time', () => {
    expect(meetsRequirement(actionOf('start'), DEFAULT_INSTALL_FACTS)).toBe(true)
    expect(meetsRequirement(actionOf('start'), EXTERNAL_FACTS)).toBe(false)
    expect(meetsRequirement(actionOf('stop'), EXTERNAL_FACTS)).toBe(false)
    expect(meetsRequirement(actionOf('status'), EXTERNAL_FACTS)).toBe(true)
    expect(meetsRequirement(actionOf('setup'), EXTERNAL_FACTS)).toBe(true)
  })

  test('disconnect, start, stop and setup are the only actions that declare a requirement', () => {
    const requiring = SECTIONS.flatMap((section) =>
      section.actions
        .filter((action) => action.requires !== undefined)
        .map((action) => `${section.id}/${action.id}`),
    )

    // Home comes before Services in `SECTIONS` (`catalogue/index.ts`), so its
    // `disconnect` (`requires: 'remote'`, 2026-09-20) leads the list.
    expect(requiring).toEqual(['home/disconnect', 'services/start', 'services/stop', 'services/setup'])
  })

  test('under an external supervisor start and stop are gone from the tab', () => {
    const services = servicesOf(visibleSections('owner', SECTIONS, EXTERNAL_FACTS))

    expect(services.actions.map((action) => action.id)).toEqual(['status', 'logs', 'setup'])
  })

  test('setup requires a LOCAL console (ADR-0014): it is gone under --remote', () => {
    expect(meetsRequirement(actionOf('setup'), DEFAULT_INSTALL_FACTS)).toBe(true)
    expect(meetsRequirement(actionOf('setup'), EXTERNAL_FACTS)).toBe(true)
    expect(meetsRequirement(actionOf('setup'), REMOTE_FACTS)).toBe(false)
  })

  test('a remote console keeps status/start/stop/logs but loses setup', () => {
    const services = servicesOf(visibleSections('owner', SECTIONS, REMOTE_FACTS))

    expect(services.actions.map((action) => action.id)).toEqual(['status', 'start', 'stop', 'logs'])
  })

  test('nothing else about the catalogue changes: the other sections are the same objects', () => {
    // Services loses start/stop; Home swaps its intro for `externalIntro` (Q32).
    // Arrange
    const owned = visibleSections('owner')

    // Act
    const external = visibleSections('owner', SECTIONS, EXTERNAL_FACTS)

    // Assert
    expect(external).toHaveLength(owned.length)
    for (const [index, section] of owned.entries()) {
      if (section.id === 'services' || section.id === 'home') expect(external[index]).not.toBe(section)
      else expect(external[index], section.id).toBe(section)
    }
  })

  test('with no facts the catalogue hands back its own sections, Home aside', () => {
    // Home alone differs even with no facts at all (`DEFAULT_INSTALL_FACTS`):
    // its `disconnect` (`requires: 'remote'`, 2026-09-20) is filtered on every
    // non-remote install, so it is never the same object as `HOME_SECTION`.
    const sections = visibleSections('owner')

    for (const [index, section] of sections.entries()) {
      if (section.id === 'home') {
        expect(section.actions.map((action) => action.id)).toEqual(['status'])
        expect(section).not.toBe(SECTIONS[index])
      } else {
        expect(section, section.id).toBe(SECTIONS[index])
      }
    }
  })
})

describe('refreshActionOf: the action r re-runs', () => {
  const sections = visibleSections('owner')

  test('finds the section’s own reader when the role may run it', () => {
    const services = sections.findIndex((section) => section.id === 'services')

    expect(refreshActionOf(sections, 'owner', services)?.id).toBe('status')
    expect(refreshActionOf(sections, 'viewer', services)?.id).toBe('status')
  })

  test('a section that names no refresh action refreshes nothing', () => {
    const audit = sections.findIndex((section) => section.id === 'audit')

    expect(refreshActionOf(sections, 'owner', audit)).toBeUndefined()
  })

  test('a refresh action with a form is refused: there would be nothing to fill it with', () => {
    const withForm: SectionSpec = {
      id: 'formy',
      title: 'Formy',
      minRole: 'viewer',
      intro: [],
      refreshActionId: 'ask',
      actions: [
        {
          id: 'ask',
          title: 'status',
          minRole: 'viewer',
          command: 'status',
          fields: [{ name: 'x', label: 'X', kind: 'text' }],
          argv: () => ['status'],
        },
      ],
    }

    expect(refreshActionOf([withForm], 'viewer', 0)).toBeUndefined()
  })

  test('a refresh action that leaves the console is refused: r would dispatch it here', () => {
    // Arrange: the catalogue edit the rule exists for — `setup` named as the
    // section's refresh. `r` and the poll timer run in-process, under the
    // alternate screen; this action must be reopened as a child (ADR-0012 §16).
    const leaving: SectionSpec = {
      id: 'leaving',
      title: 'Leaving',
      minRole: 'viewer',
      intro: [],
      refreshActionId: 'setup',
      actions: [
        {
          id: 'setup',
          title: 'setup',
          minRole: 'viewer',
          command: 'setup',
          leavesConsole: true,
          fields: [],
          argv: () => ['setup'],
        },
      ],
    }

    // Act & Assert
    expect(refreshActionOf([leaving], 'viewer', 0)).toBeUndefined()
  })

  test('an index outside the list, or a role too low, is undefined rather than a crash', () => {
    expect(refreshActionOf(sections, 'owner', sections.length)).toBeUndefined()
    expect(refreshActionOf(sections, 'owner', -1)).toBeUndefined()
    expect(refreshActionOf(sections, 'viewer', sections.findIndex((s) => s.id === 'admins'))).toBeUndefined()
  })
})
