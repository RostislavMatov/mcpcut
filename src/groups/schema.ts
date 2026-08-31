import { z } from 'zod'
import {
  agentGrantSchema,
  agentNameSchema,
  findReservedKeyPath,
  grantServerNameSchema,
  withMaxEntries,
} from '../agents/schema.js'
import { RESERVED_OBJECT_KEYS } from '../policy/constants.js'
import {
  GROUP_NAME_PATTERN,
  MAX_GROUPS,
  MAX_MEMBERS_PER_GROUP,
  MAX_SERVERS_PER_GROUP,
} from './constants.js'

/**
 * zod schema for the `groups.json` document. Same trust boundary as
 * `agents/schema.ts`: the store is CLI/UI-managed, but a corrupt or
 * hand-edited document must fail LOUDLY, never degrade into "this group
 * grants nothing" (which would silently narrow an agent's access) or "this
 * group has no members" (which would let a still-used group be deleted).
 * Every object is `z.strictObject`, maps reject reserved keys, and
 * `parseGroupsFile` pre-scans the raw value for `__proto__` before zod can
 * silently drop it.
 *
 * A group grant is an AGENT grant (`agentGrantSchema`, decision G1): one
 * grant shape, one matcher, one set of limits — the effective-grants resolver
 * (G2) merges values of exactly the same type it hands to `agents/scope.ts`.
 */

const groupNameSchema = z
  .string()
  .regex(GROUP_NAME_PATTERN, `group name must match ${GROUP_NAME_PATTERN.source}`)

/**
 * One member: an agent NAME, reserved words rejected as values even though
 * members are an array, not a map — the same "one uniform rule beats two
 * subtly different ones" call `agentGrantSchema` makes for tool patterns, and
 * it keeps the schema exactly as permissive as the store's `addMember`.
 */
const memberNameSchema = agentNameSchema.refine(
  (name) => !RESERVED_OBJECT_KEYS.includes(name),
  { message: 'reserved name is not allowed as a member' },
)

/**
 * The membership list, stored sorted by UTF-16 code unit and duplicate-free.
 * Sorted-and-unique is a SCHEMA invariant rather than a store convention on
 * purpose: the document is the only place membership lives (G3 refinement),
 * so a duplicate would double-count a member in "still has members" and an
 * unsorted list would make the persisted bytes depend on insertion order.
 *
 * Code-unit order (plain `<`), never `localeCompare`: the document must be
 * byte-identical across platforms and ICU versions, which is the same reason
 * `policy/provenance.ts` sorts its matrix that way.
 */
const membersSchema = z
  .array(memberNameSchema)
  .max(MAX_MEMBERS_PER_GROUP, `too many members: max ${MAX_MEMBERS_PER_GROUP}`)
  .superRefine((members, ctx) => {
    for (let i = 1; i < members.length; i += 1) {
      const previous = members[i - 1] as string
      const current = members[i] as string
      if (current === previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate member "${current}"`,
          path: [i],
        })
      } else if (current < previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'members must be sorted by UTF-16 code unit',
          path: [i],
        })
      }
    }
  })

export const groupRecordSchema = z.strictObject({
  name: groupNameSchema,
  createdAt: z.iso.datetime(),
  grants: withMaxEntries(
    grantServerNameSchema,
    agentGrantSchema,
    MAX_SERVERS_PER_GROUP,
    'grants',
  ),
  members: membersSchema,
})

/** One group: its per-server grants (G1) plus the agents that inherit them (G2). */
export type GroupRecord = z.infer<typeof groupRecordSchema>

export const groupsFileSchema = z.strictObject({
  version: z.literal(1),
  groups: withMaxEntries(groupNameSchema, groupRecordSchema, MAX_GROUPS, 'groups').superRefine(
    (groups, ctx) => {
      for (const [key, record] of Object.entries(groups)) {
        if (record.name !== key) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `groups key "${key}" does not match the record's name "${record.name}"`,
            path: [key, 'name'],
          })
        }
      }
    },
  ),
})

/** The whole `groups.json` document. */
export type GroupsFile = z.infer<typeof groupsFileSchema>

/** Discriminated result of validating a groups file. Never throws. */
export type ParseGroupsResult =
  | { readonly ok: true; readonly file: GroupsFile }
  | { readonly ok: false; readonly error: z.ZodError }

/**
 * Validates a raw, untrusted value (the parsed JSON document). Pre-scans for
 * reserved own-keys first: `JSON.parse` materializes `__proto__` as an own
 * property but zod's record rebuild silently drops it BEFORE `superRefine`
 * runs, which would turn a smuggled `__proto__` group (or grant) into a
 * silently vanished one — the same fail-open hazard `agents/schema.ts` and
 * `policy/schema.ts` document.
 */
export function parseGroupsFile(value: unknown): ParseGroupsResult {
  const reservedPath = findReservedKeyPath(value, [])
  if (reservedPath) {
    const error = new z.ZodError([
      {
        code: 'custom',
        message: `reserved key "${String(reservedPath.at(-1))}" is not allowed`,
        path: reservedPath,
      },
    ])
    return { ok: false, error }
  }

  const result = groupsFileSchema.safeParse(value)
  if (result.success) {
    return { ok: true, file: result.data }
  }
  return { ok: false, error: result.error }
}
