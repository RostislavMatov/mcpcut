/**
 * Errors tenant mode raises (PRD `hosted-accounts`, phase 1, ADR-0017). Same
 * shape as the registry's own error classes (`DuplicateServerError`,
 * `InvalidServerRecordError` — `src/registry/store.ts`): `extends Error`, a
 * human-readable message built in the constructor, `this.name` set so
 * `describeError` and the journal print the class name rather than a bare
 * "Error".
 */

/**
 * Raised wherever a stdio server would otherwise be registered or started,
 * once `tenant.stdioServers` is `'refused'`: a hosted install refuses to run
 * an arbitrary command on its own host on the owner's behalf. One class
 * covers both the registry-write gate (a new stdio record) and the
 * start-time lock (a stdio record written before the mode was turned on) —
 * both are the same refusal, just caught at a different point.
 */
export class StdioServerRefusedError extends Error {
  constructor(serverName: string) {
    super(
      `server "${serverName}" is stdio: this install refuses stdio servers (tenant mode) — register it over https`,
    )
    this.name = 'StdioServerRefusedError'
  }
}
