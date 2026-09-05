/**
 * The one honest way to read an `errno` code off a thrown value. A `catch`
 * receives `unknown`, and a code is only trustworthy when it is really there
 * and really a string — so this narrows instead of casting (the convention
 * `cli/bind-failure.ts` set). Kept import-free on purpose: `src/setup/load.ts`
 * runs while `src/config.ts` is being evaluated, and the architecture test
 * (`tests/architecture/imports.test.ts`) allows that chain to reach only
 * `zod`, `node:*`, import-free leaves like this one, and its own siblings.
 */
export function errnoCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}
