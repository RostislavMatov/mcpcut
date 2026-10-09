import { describe, expect, test } from 'vitest'
import { APP_JS } from '../../src/ui/assets/app-js.js'
import { renderQueueRegion, type ApprovalCardView } from '../../src/ui/pages/approval-queue.js'

/**
 * The approval card's clocks (M36: a held call waits as long as its agent
 * does, so a "waiting 47s" frozen at render time would read as 47 seconds an
 * hour later). The server renders each clock with `data-clock` and
 * `data-clock-sec`; the shipped APP_JS ticks it on, and re-reads the queue
 * region on `data-live-every` so the connected/silent state follows the agent
 * with no event. The functions run out of the real APP_JS source
 * (page-contracts pattern) against stub nodes.
 */

const JS_SOURCE = APP_JS.body.toString('utf8')

function shipped(name: string): string {
  const source = new RegExp(`\\n {2}function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}`).exec(JS_SOURCE)?.[0]
  expect(source, `${name} not found in APP_JS`).toBeDefined()
  return source ?? ''
}

interface NodeStub {
  textContent: string
  readonly attrs: Map<string, string>
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
}

function clockNode(direction: 'up' | 'down', seconds: number): NodeStub {
  const attrs = new Map([
    ['data-clock', direction],
    ['data-clock-sec', String(seconds)],
  ])
  return {
    textContent: `${seconds}s`,
    attrs,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => {
      attrs.set(name, value)
    },
  }
}

function loadFormatClock(): (seconds: number) => string {
  return new Function(`${shipped('formatClock')}\nreturn formatClock;`)() as (seconds: number) => string
}

function loadTickClocks(nodes: readonly NodeStub[]): (nowMs: number) => void {
  const documentStub = { querySelectorAll: () => nodes }
  return new Function('document', `${shipped('formatClock')}\n${shipped('tickClocks')}\nreturn tickClocks;`)(
    documentStub,
  ) as (nowMs: number) => void
}

const SAMPLE_CARD: ApprovalCardView = {
  approvalId: '01J0000000000000000000000C',
  serverName: 'probe',
  toolName: 'slow_echo',
  toolClass: 'write',
  argsRedacted: {},
  waitingSec: 0,
}

function serverClockText(waitingSec: number): string {
  const html = String(renderQueueRegion({ cards: [{ ...SAMPLE_CARD, waitingSec }], csrfToken: 'csrf' }))
  return /data-clock="up" data-clock-sec="\d+">([^<]*)</.exec(html)?.[1] ?? ''
}

describe('formatClock in APP_JS', () => {
  test('writes a duration exactly as the server rendered it, so a tick never changes the format', () => {
    const formatClock = loadFormatClock()
    for (const seconds of [0, 7, 59, 60, 125, 3599, 3600, 3720, 90_000]) {
      expect(formatClock(seconds)).toBe(serverClockText(seconds))
    }
  })

  test('never shows a negative duration', () => {
    expect(loadFormatClock()(-5)).toBe('0s')
  })
})

describe('tickClocks in APP_JS', () => {
  test('counts the agent wait on from what the server measured', () => {
    const waiting = clockNode('up', 47)
    const tick = loadTickClocks([waiting])

    tick(1_000_000)
    expect(waiting.textContent).toBe('47s')
    tick(1_013_000)
    expect(waiting.textContent).toBe('1m0s')
  })

  test('counts a capped wait down to zero and no further', () => {
    const closes = clockNode('down', 42)
    const tick = loadTickClocks([closes])

    tick(2_000_000)
    tick(2_040_000)
    expect(closes.textContent).toBe('2s')
    tick(2_050_000)
    expect(closes.textContent).toBe('0s')
  })

  test('a wall clock set back never runs a clock below what the server measured', () => {
    const waiting = clockNode('up', 47)
    const tick = loadTickClocks([waiting])

    tick(4_000_000)
    tick(3_990_000)
    expect(waiting.textContent).toBe('47s')
  })

  test('a clock swapped in by a region refresh starts from its own fresh value', () => {
    const before = clockNode('up', 10)
    const tick = loadTickClocks([before])
    tick(3_000_000)

    const after = clockNode('up', 70)
    loadTickClocks([after])(3_060_000)

    expect(after.textContent).toBe('1m10s')
  })
})

describe('regions that re-read themselves (data-live-every) in APP_JS', () => {
  interface Scene {
    readonly every?: string
    readonly hasClock?: boolean
    readonly hidden?: boolean
    /** Focus sits on a control inside the region (a ticked box, a tabbed-to button). */
    readonly focusInside?: boolean
    /** Text inside the region is selected (args being copied). */
    readonly selectionInside?: boolean
  }

  interface Wired {
    readonly periodMs: number | undefined
    /** Runs the timer once; returns the refreshes so far. */
    readonly tick: () => number
    /** The tab comes back into view; returns the refreshes so far. */
    readonly showTab: () => number
  }

  function wire(scene: Scene): Wired {
    let timer: (() => void) | undefined
    let onVisibility: (() => void) | undefined
    let periodMs: number | undefined
    let refreshes = 0
    const inside = { inside: true }
    const body = { body: true }
    const regionNode = {
      getAttribute: (name: string) => (name === 'data-live-every' ? (scene.every ?? '30000') : null),
      querySelector: (selector: string) => (selector === '[data-clock-sec]' && scene.hasClock !== false ? {} : null),
      contains: (node: unknown) => node === inside,
    }
    const documentStub = {
      hidden: scene.hidden === true,
      body,
      activeElement: scene.focusInside === true ? inside : body,
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'visibilitychange') onVisibility = fn
      },
    }
    const windowStub = {
      getSelection: () =>
        scene.selectionInside === true ? { isCollapsed: false, anchorNode: inside } : { isCollapsed: true, anchorNode: null },
    }
    const wireAgingRegion = new Function(
      'document',
      'window',
      'setInterval',
      'refreshRegion',
      `${shipped('isOperatorBusyIn')}\n${shipped('refreshIfAging')}\n${shipped('wireAgingRegion')}\nreturn wireAgingRegion;`,
    )(
      documentStub,
      windowStub,
      (fn: () => void, ms: number) => {
        timer = fn
        periodMs = ms
      },
      () => {
        refreshes += 1
      },
    ) as (node: unknown) => void
    wireAgingRegion(regionNode)
    return {
      periodMs,
      tick: () => {
        timer?.()
        return refreshes
      },
      showTab: () => {
        onVisibility?.()
        return refreshes
      },
    }
  }

  test('re-reads a region that shows a clock on its own period', () => {
    const wired = wire({})
    expect(wired.periodMs).toBe(30_000)
    expect(wired.tick()).toBe(1)
  })

  test('re-reads at once when the tab comes back into view', () => {
    expect(wire({}).showTab()).toBe(1)
  })

  test('leaves an empty queue alone: nothing on it ages', () => {
    expect(wire({ hasClock: false }).tick()).toBe(0)
  })

  test('does not read while the tab is hidden', () => {
    expect(wire({ hidden: true }).tick()).toBe(0)
  })

  test('waits while focus is on a control in the region: the swap would drop it', () => {
    expect(wire({ focusInside: true }).tick()).toBe(0)
  })

  test('waits while text in the region is selected: the swap would drop the selection', () => {
    expect(wire({ selectionInside: true }).tick()).toBe(0)
  })

  test('ignores a period that is not a positive number', () => {
    expect(wire({ every: 'soon' }).periodMs).toBeUndefined()
  })

  test('the page script wires both on start', () => {
    const init = shipped('init')
    expect(init).toContain('wireAgingRegions()')
    expect(init).toContain('startClocks()')
  })
})
