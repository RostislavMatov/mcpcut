import type { MethodGrantsInput } from '../agents/store.js'

/**
 * The `--tools` / `--resources` / `--prompts` flags shared by every command
 * that writes a grant — `agent grant` (M3) and `group grant` (M5.5 п.2, plan
 * Task 9). One grant SHAPE (decision G1) must be reachable through one flag
 * parser: a group grant that read `--resources` differently from an agent
 * grant would make "the same grant" mean two things.
 *
 * The asymmetric defaults live here too, because they are the security
 * contract rather than a formatting detail: an absent `--tools` grants ALL
 * tools, while an absent `--resources`/`--prompts` leaves those method
 * surfaces DENIED. Opening a method surface is always an explicit act.
 */

/** Raw flag values as `parseArgs` hands them over. */
export interface GrantFlagValues {
  readonly tools?: string | undefined
  readonly resources?: string | undefined
  readonly prompts?: string | undefined
}

/** The parsed grant input, or the message explaining which flag was empty. */
export type GrantFlagsResult =
  | { readonly ok: true; readonly tools: readonly string[] | '*'; readonly methods: MethodGrantsInput }
  | { readonly ok: false; readonly message: string }

const EMPTY_TOOLS_MESSAGE =
  '--tools was given but contains no tool patterns (expected e.g. --tools get_*,list_issues)\n'
const EMPTY_RESOURCES_MESSAGE =
  '--resources was given but contains no URI patterns (expected e.g. --resources file:///project/*)\n'
const EMPTY_PROMPTS_MESSAGE =
  '--prompts was given but contains no prompt patterns (expected e.g. --prompts greet*)\n'

/** No flag → `'*'`; a flag that boils down to zero patterns → `'empty'` (an error). */
export function parseToolsFlag(value: string | undefined): readonly string[] | '*' | 'empty' {
  if (value === undefined) return '*'
  return splitPatterns(value)
}

/**
 * `--resources`/`--prompts`: ABSENT means "leave the field out" (the M3
 * fail-closed denial stands) — unlike `--tools`, where absence means
 * everything. Opening a method surface must always be an explicit act.
 */
export function parseMethodFlag(
  value: string | undefined,
): readonly string[] | '*' | 'empty' | undefined {
  if (value === undefined) return undefined
  if (value.trim() === '*') return '*'
  return splitPatterns(value)
}

export function splitPatterns(value: string): readonly string[] | '*' | 'empty' {
  const patterns = value
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
  return patterns.length === 0 ? 'empty' : patterns
}

/**
 * All three flags at once: the tools value plus the `MethodGrantsInput` the
 * stores accept, or the first empty-flag message for the caller to print
 * before exiting 1.
 */
export function resolveGrantFlags(values: GrantFlagValues): GrantFlagsResult {
  const tools = parseToolsFlag(values.tools)
  if (tools === 'empty') return { ok: false, message: EMPTY_TOOLS_MESSAGE }
  const resources = parseMethodFlag(values.resources)
  if (resources === 'empty') return { ok: false, message: EMPTY_RESOURCES_MESSAGE }
  const prompts = parseMethodFlag(values.prompts)
  if (prompts === 'empty') return { ok: false, message: EMPTY_PROMPTS_MESSAGE }

  return {
    ok: true,
    tools,
    methods: {
      ...(resources !== undefined ? { resources } : {}),
      ...(prompts !== undefined ? { prompts } : {}),
    },
  }
}
