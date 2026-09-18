import { checkBindExposure } from '../setup/bind-checks.js'
import type { InstallConfig } from '../setup/schema.js'
import type { ServiceStatus } from './manager-types.js'

/**
 * The exposure warning on `mcpcut status` (Q31, ADR-0004).
 *
 * `setup` and the wizard already warn about a bind other hosts can reach, but
 * they run once; `status` is what an operator reads every day, and a service
 * left on `0.0.0.0` without TLS in front stayed silent there. The finding is
 * `checkBindExposure`'s own, so both surfaces say the same sentence.
 *
 * The status HOST is judged, not the config bind: with a pid file that host is
 * the record's — where the process really listens — and an edited config must
 * not talk the warning away.
 *
 * Every state is judged, `stopped` included, on purpose: the warning is about
 * the configured bind, which is reachable the moment the service starts — the
 * same reading the `setup` preflight gives before anything runs. Silencing it
 * for a stopped service would hide the finding exactly when it is cheapest to
 * act on.
 *
 * `exposure` lives on each service rather than at the root of the document:
 * `status --json` is an array, and the console reads it back with a non-strict
 * per-item schema (`src/tui/services-summary.ts`) — a root object would blank
 * the header of every console already deployed. A loopback status comes back
 * as the SAME object, so an install with nothing to warn about keeps its
 * `--json` byte for byte.
 */
export function withExposure(config: InstallConfig, status: ServiceStatus): ServiceStatus {
  // `--behind-tls` is a ui flag only; serve's bearer tokens have no such claim.
  const behindTls = status.service === 'ui' && config.ui.behindTls === true
  const check = checkBindExposure(status.service, status.host, behindTls)
  return check.level === 'warn' ? { ...status, exposure: { level: 'warn', detail: check.detail } } : status
}
