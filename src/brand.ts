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

/**
 * The product version the plane reports for ITSELF — today only in the
 * `serverInfo` of a pool address, where the plane is the server (ADR-0015 §4,
 * PE12) and the spec requires a version string.
 *
 * A literal rather than a read of `package.json`, because the plane must not
 * depend on its own package layout at runtime: `connect --url` already runs
 * from a machine with no install at all, and a missing file is not an answer
 * `initialize` can give. It is kept honest by a test that fails the moment
 * this and `package.json` disagree, so the duplication cannot drift silently.
 */
export const PRODUCT_VERSION = '0.1.2'

/**
 * Where a message sends an operator for the details: the guide in the public
 * repository. An address rather than a file name, because the npm package
 * ships the README and not `docs/`.
 */
export const GUIDE_URL = 'https://github.com/RostislavMatov/mcpcut/blob/main/docs/guide'
