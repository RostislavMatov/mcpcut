/**
 * The product name, and the single source of it.
 *
 * It used to live in `src/ui/constants.ts`, which is fine for the console but
 * not for the operator surfaces added in the `mcpcut` phase-1 work: the
 * architecture tests forbid `src/setup/**` and `src/services/**` from
 * importing anything under `src/ui/**` (the admin UI is an operator surface
 * with its own threat model — ADR-0004), so a shared constant cannot live
 * there. Hence a leaf module with no imports at all: `src/ui/constants.ts`
 * re-exports it and every other area imports it from here, so a rename is
 * still one edit.
 */
export const BRAND_NAME = 'McpCut'
