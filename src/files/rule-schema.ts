import path from 'node:path'
import { z } from 'zod'
import { FILE_OPS, MAX_PATH_LENGTH } from './constants.js'

/** An absolute path of bounded length without a NUL byte — shared by rules and roots. */
export const absolutePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((value) => !value.includes('\u0000'), 'path must not contain a NUL byte')
  .refine((value) => path.isAbsolute(value), 'path must be absolute')

const identityNumberSchema = z.string().regex(/^-?\d{1,25}$/)

/**
 * One folder rule in a grant (ADR-0020 §2): an absolute path and the
 * operations on it. An empty `ops` list is meaningful — it cuts a subfolder
 * out of a wider rule — so it is allowed; a repeated operation is not.
 */
export const fileRuleSchema = z.strictObject({
  path: absolutePathSchema,
  /** A cut-out's folder as it was when granted (dev/ino as decimal strings): moved or replaced, it closes access. */
  identity: z.strictObject({ dev: identityNumberSchema, ino: identityNumberSchema }).optional(),
  ops: z
    .array(z.enum(FILE_OPS))
    .max(FILE_OPS.length)
    .refine((ops) => new Set(ops).size === ops.length, 'ops must not repeat an operation'),
})
