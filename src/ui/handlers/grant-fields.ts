import type { MethodGrantsInput } from '../../agents/grant-input.js'

/**
 * How a grant form's pattern fields are read, shared by `/agents` and
 * `/groups`. A group grant IS an agent grant (decision G1), so the two forms
 * must interpret an empty `resources` box, a lone `*` and a comma-separated
 * list identically — two spellings of that would be two different fail-closed
 * defaults wearing the same label.
 */

/** Splits a whitespace/comma-separated pattern field into trimmed non-empty entries. */
export function parseList(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Interprets one grant-dimension field: absent/empty → `undefined` (leave the
 * dimension unset, keeping the M3 fail-closed denial); a lone `*` → `'*'`;
 * otherwise the explicit pattern list.
 */
export function parseGrantValue(value: string | undefined): '*' | string[] | undefined {
  const list = parseList(value)
  if (list.length === 0) return undefined
  if (list.length === 1 && list[0] === '*') return '*'
  return list
}

/** The optional resources/prompts dimensions of one submitted grant form. */
export function methodGrantsFrom(form: Readonly<Record<string, string>>): MethodGrantsInput {
  const resources = parseGrantValue(form.resources)
  const prompts = parseGrantValue(form.prompts)
  return {
    ...(resources !== undefined ? { resources } : {}),
    ...(prompts !== undefined ? { prompts } : {}),
  }
}
