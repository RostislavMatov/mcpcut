import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { MAX_TCP_PORT } from '../cli/serve-constants.js'
import {
  INSTALL_CONFIG_VERSION,
  MAX_CONFIG_STRING_LENGTH,
  MAX_HOST_LENGTH,
  MAX_LIST_ENTRIES,
  REJECTED_ORIGIN_VALUE,
  SUPERVISORS,
} from './constants.js'

/**
 * The install config's schema (phase 1, task 2). `strictObject` at every
 * level is a security property, not tidiness: the config is not a credential
 * store, and an unknown key is refused rather than ignored, so a `token`,
 * `secret` or `password` an operator (or a template) drops into the file
 * fails the install loudly instead of sitting on disk unread.
 *
 * IMPORT INVARIANT: `zod`, `node:*` and `../cli/serve-constants.js` only —
 * see the header of `./constants.ts`.
 */

/** `0` means "any free port" and stays legal, as it is for the flags. */
const portSchema = z.number().int().min(0).max(MAX_TCP_PORT)

const hostSchema = z.string().min(1).max(MAX_HOST_LENGTH)

const boundedString = z.string().min(1).max(MAX_CONFIG_STRING_LENGTH)

const stringList = z.array(boundedString).max(MAX_LIST_ENTRIES)

const originList = z
  .array(
    boundedString.refine(
      (value) => value !== REJECTED_ORIGIN_VALUE,
      `the opaque origin "${REJECTED_ORIGIN_VALUE}" can never be allowed`,
    ),
  )
  .max(MAX_LIST_ENTRIES)

const bindSchema = z.strictObject({ host: hostSchema, port: portSchema })

/**
 * The address `status` dials when the service has no pid file — compose or
 * systemd, where the service is the neighbour's name on the network (Q32).
 * It never changes the bind: `host` stays where the service listens.
 */
const probeHostSchema = hostSchema.optional()

export const installConfigSchema = z.strictObject({
  version: z.literal(INSTALL_CONFIG_VERSION),
  dataDir: boundedString.refine(isAbsolute, 'dataDir must be an absolute path'),
  ui: bindSchema.extend({
    probeHost: probeHostSchema,
    behindTls: z.boolean().optional(),
    allowedHosts: stringList.optional(),
    allowedOrigins: originList.optional(),
    trustedProxyHeader: boundedString.optional(),
  }),
  serve: bindSchema.extend({
    probeHost: probeHostSchema,
    allowedHosts: stringList.optional(),
    allowedOrigins: originList.optional(),
    failClosed: z.boolean().optional(),
    policy: boundedString.optional(),
  }),
  supervisor: z.enum(SUPERVISORS).optional(),
})

/** The whole `~/.mcpcut/config.json` document. */
export type InstallConfig = z.infer<typeof installConfigSchema>

/**
 * Renders a `z.ZodError` as one human-readable line per issue, the shape
 * `formatPolicyErrors` (`src/policy/load.ts`) fixed: `path.to.field: message`,
 * `(root): message` for a pathless issue, and a `strictObject`'s single
 * `unrecognized_keys` issue expanded into one `path: unknown key "x"` line
 * per key — four stray keys must read as four lines, not one vague one.
 */
export function formatInstallConfigErrors(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => `${path}: unknown key "${key}"`)
    }
    return [`${path}: ${issue.message}`]
  })
}
