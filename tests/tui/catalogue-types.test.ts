import { describe, expect, test } from 'vitest'
import { typecheckSource as typecheck } from '../support/typecheck.js'

/**
 * The one `ActionSpec` invariant that is a security property rather than a UX
 * one, expressed as a type (owner tail Q23 of mcpcut phase 4).
 *
 * `stdinField` names a `secret` field whose value the runtime hands straight
 * to the command's stdin. `confirm` makes the console park the filled form in
 * the model until the operator answers a question. An action carrying both
 * would put a secret in the model — which is what `vault set` exists not to
 * do, and what `tests/tui/catalogue-invariants.test.ts` asserts over the
 * catalogue as it stands today. That test cannot speak for the twelfth
 * section nobody has written yet; the compiler can.
 *
 * These are compile-time tests because `tsconfig.json` excludes `tests/` and
 * vitest transpiles without typechecking — a bare `@ts-expect-error` here
 * would pin nothing. See `tests/support/typecheck.ts`.
 */

/** The import line every fixture below starts from. */
const IMPORT_LINE = `import type { ActionSpec } from '../../src/tui/catalogue/types.js'`

/** The members every `ActionSpec` carries, whichever arm of the union it is. */
const COMMON_MEMBERS = `
  id: 'demo',
  title: 'demo',
  minRole: 'owner',
  command: 'demo',
  fields: [{ name: 'value', label: 'Value', kind: 'secret' }],
  argv: () => ['demo'],
`

describe('an action cannot both read stdin and ask a question', () => {
  test('declaring stdinField beside confirm does not compile', () => {
    // Arrange + Act
    const diagnostics = typecheck(`
      ${IMPORT_LINE}

      export const bothAction: ActionSpec = {
        ${COMMON_MEMBERS}
        stdinField: 'value',
        confirm: () => 'Really?',
      }
    `)

    // Assert: the assignment is refused, and the refusal names the pair.
    expect(diagnostics).toMatch(/error TS2(322|375|353)/)
    expect(diagnostics).toMatch(/confirm/)
  })

  test('stdinField alone compiles', () => {
    const diagnostics = typecheck(`
      ${IMPORT_LINE}

      export const stdinAction: ActionSpec = {
        ${COMMON_MEMBERS}
        stdinField: 'value',
      }
    `)

    expect(diagnostics).toBe('')
  })

  test('confirm alone compiles', () => {
    const diagnostics = typecheck(`
      ${IMPORT_LINE}

      export const confirmAction: ActionSpec = {
        ${COMMON_MEMBERS}
        confirm: () => 'Really?',
      }
    `)

    expect(diagnostics).toBe('')
  })

  test('an action with neither compiles', () => {
    const diagnostics = typecheck(`
      ${IMPORT_LINE}

      export const plainAction: ActionSpec = {
        ${COMMON_MEMBERS}
      }
    `)

    expect(diagnostics).toBe('')
  })
})

describe('reading either seam off the union stays possible', () => {
  test('both members are readable without narrowing, as the runtime reads them', () => {
    // What `src/tui/update-form.ts` does: `action.stdinField === undefined`
    // and `action.confirm?.(values)`, on a value of the union type.
    const diagnostics = typecheck(`
      ${IMPORT_LINE}
      import type { FormValues } from '../../src/tui/form.js'

      export function stdinOf(action: ActionSpec, values: FormValues): string | undefined {
        return action.stdinField === undefined ? undefined : (values[action.stdinField] ?? '')
      }

      export function questionOf(action: ActionSpec, values: FormValues): string | undefined {
        return action.confirm?.(values)
      }
    `)

    expect(diagnostics).toBe('')
  })
})
