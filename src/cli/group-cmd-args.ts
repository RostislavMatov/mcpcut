import { parseArgs } from 'node:util'
import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import type { Role } from '../admin/authz.js'
import { ACCESS_MIN_ROLE } from './access-cmd-write.js'
import type { GroupCliIo } from './group-cmd.js'
import { resolveGrantFlags } from './grant-flags.js'

/**
 * The argument surface of `group ...`: its usage text and the parsers that
 * turn `argv` into names and a grant. Split out of `group-cmd.ts` so that file
 * stays about what each subcommand DOES (token, existence checks, store,
 * journal) and this one about what the operator typed.
 *
 * Every parser follows the M2/M3 convention: it prints the usage itself and
 * returns `undefined`, so the caller's refusal is a single `return 1`.
 */

/**
 * Minimum role for every `group` mutation — the same row the UI applies to
 * `POST /groups/*` (G4). It lives here because the usage text states it, and a
 * usage text that imported it back from the command module would make the two
 * files a runtime cycle.
 */
export const GROUP_MIN_ROLE: Role = ACCESS_MIN_ROLE

export const USAGE = `Usage:
  group create <name>                          Create an empty group
  group remove <name>                          Remove a group (refused while it still has members)
  group list                                   List groups with their server and member counts
  group show <name>                            Print one group's grants and members
  group grant <group> <server> --tools a,b,prefix*|* [--resources uri,uriprefix*|*] [--prompts name,prefix*|*]
                                               Grant server access to the group. --tools is REQUIRED here
                                               (unlike agent grant): the grant lands on every member at once,
                                               so "all tools" must be typed as --tools '*'.
                                                 omitting --resources keeps resources/* DENIED,
                                                 omitting --prompts keeps prompts/* DENIED
                                               (opening a method surface is always an explicit act)
  group ungrant <group> <server>               Remove the group's grant for a server
  group join <group> <agent>                   Add an agent to the group (it inherits the group's grants)
  group leave <group> <agent>                  Remove an agent from the group
Members inherit the group's grants; a personal grant for the same server wins.
Every change needs a personal admin token in ${ADMIN_TOKEN_ENV_VAR} (role ${GROUP_MIN_ROLE}); list and show do not.
`

/** True when the argument list is exactly `count` plain (non-flag) positionals. */
export function hasPositionals(args: string[], count: number): boolean {
  return args.length === count && !args.some((value) => value.startsWith('-'))
}

/** The single `<name>` positional, or `undefined` with the usage already printed. */
export function oneName(args: string[], io: GroupCliIo): string | undefined {
  const [name] = args
  if (!hasPositionals(args, 1) || name === undefined) {
    io.stderr.write(USAGE)
    return undefined
  }
  return name
}

/** The `<group> <server>` / `<group> <agent>` pair, or `undefined` with the usage printed. */
export function twoNames(args: string[], io: GroupCliIo): readonly [string, string] | undefined {
  const [first, second] = args
  if (!hasPositionals(args, 2) || first === undefined || second === undefined) {
    io.stderr.write(USAGE)
    return undefined
  }
  return [first, second]
}

/** The two positionals and three flags of `group grant`; `undefined` with usage printed. */
export interface GrantArgs {
  readonly group: string
  readonly server: string
  readonly tools: readonly string[] | '*'
  readonly methods: { readonly resources?: '*' | readonly string[]; readonly prompts?: '*' | readonly string[] }
}

/** The T2 refusal: names the flag and the explicit way to grant everything. */
const MISSING_TOOLS_MESSAGE =
  '--tools is required for a group grant: the grant applies to every member at once.\n' +
  "Type the surface out (--tools read_file,list_*) or grant everything explicitly: --tools '*'\n"

export function parseGrantArgs(args: string[], io: GroupCliIo): GrantArgs | undefined {
  let names: string[]
  let toolsValue: string | undefined
  let resourcesValue: string | undefined
  let promptsValue: string | undefined
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        tools: { type: 'string' },
        resources: { type: 'string' },
        prompts: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    names = parsed.positionals
    toolsValue = parsed.values.tools
    resourcesValue = parsed.values.resources
    promptsValue = parsed.values.prompts
  } catch {
    io.stderr.write(USAGE)
    return undefined
  }

  const [group, server] = names
  if (group === undefined || server === undefined || names.length !== 2) {
    io.stderr.write(USAGE)
    return undefined
  }

  // Owner decision T2 (2026-09-01): unlike `agent grant`, a group grant has no
  // default tools. `agent grant` may keep its asymmetric default — one agent,
  // one operator, one decision — but here the cost of a mistaken `'*'` is
  // multiplied by the member count, so "all tools" must be typed out.
  if (toolsValue === undefined) {
    io.stderr.write(MISSING_TOOLS_MESSAGE)
    return undefined
  }

  const flags = resolveGrantFlags({
    tools: toolsValue,
    resources: resourcesValue,
    prompts: promptsValue,
  })
  if (!flags.ok) {
    io.stderr.write(flags.message)
    return undefined
  }
  return { group, server, tools: flags.tools, methods: flags.methods }
}
