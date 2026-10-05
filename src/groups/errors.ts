import type { z } from 'zod'
import { GROUP_NAME_PATTERN } from './constants.js'

/** The groups store's errors, split out of `store.ts` for its line budget; `store.ts` re-exports them. */

/** Raised when creating a group whose name is already taken. */
export class GroupExistsError extends Error {
  constructor(name: string) {
    super(`group "${name}" already exists`)
    this.name = 'GroupExistsError'
  }
}

/** Raised when an operation targets a group that does not exist. */
export class GroupNotFoundError extends Error {
  constructor(name: string) {
    super(`group "${name}" does not exist`)
    this.name = 'GroupNotFoundError'
  }
}

/** Raised for a group name outside `^[a-z0-9][a-z0-9-]{0,63}$` (or a reserved word). */
export class InvalidGroupNameError extends Error {
  constructor(name: string) {
    super(`invalid group name "${name}": must match ${GROUP_NAME_PATTERN.source}`)
    this.name = 'InvalidGroupNameError'
  }
}

/**
 * Raised by `createGroup` (tenant mode) once the store already holds
 * `tenant.limits.groups` records. Enforced on WRITE only, same GOTCHA as
 * `TooManyServersError` (`src/registry/store.ts`): the read schema's own
 * ceiling (`MAX_GROUPS`) is untouched, so a tenant mode turned on over an
 * already-large install keeps reading fine.
 */
export class TooManyGroupsError extends Error {
  constructor(max: number) {
    super(`too many groups: max ${max} (tenant mode)`)
    this.name = 'TooManyGroupsError'
  }
}

/** Thrown by the injected validator; surfaced to callers wrapped in `StoreCorruptError`. */
export class GroupsFileInvalidError extends Error {
  constructor(error: z.ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ')
    super(`groups file failed validation: ${details}`)
    this.name = 'GroupsFileInvalidError'
  }
}
