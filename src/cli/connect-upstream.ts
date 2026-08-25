/**
 * Moved to `src/upstream/prepare.ts` (M5.5, probe engine): the probe reuses
 * the exact spawn/connect/vault-resolve path `connect` uses, and it may not
 * live under `src/cli/**`. This re-export keeps every existing importer and
 * test working unchanged (the `security/token.ts` extraction pattern).
 */
export {
  formatVaultFailure,
  prepareUpstream,
  type ConnectUpstream,
  type PreparedUpstream,
  type PrepareUpstreamArgs,
  type PrepareUpstreamResult,
} from '../upstream/prepare.js'
