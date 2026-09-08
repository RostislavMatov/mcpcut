import { describe, expect, test } from 'vitest'
import { freePort, holdPort } from './wizard-harness.js'

/**
 * The two port helpers the wizard e2e stand is built on.
 *
 * They are test support, and tested anyway for one reason: both used to
 * `listen` with no `'error'` listener, so a bind that failed — the very thing
 * `holdPort` exists to arrange — left the promise pending and the scenario
 * hanging to its 20 s timeout, which reads as "the wizard is slow" rather than
 * "the port was taken". A rejection is the only failure worth having here.
 */

/** A hang would be the bug; anything the helpers do should take milliseconds. */
const HELPER_TIMEOUT_MS = 2_000

describe('the wizard stand ports', () => {
  test(
    'freePort answers with a port a listener can then take',
    async () => {
      const port = await freePort()

      expect(port).toBeGreaterThan(0)
      const release = await holdPort(port)
      await release()
    },
    HELPER_TIMEOUT_MS,
  )

  test(
    'a second holdPort on the same port rejects instead of hanging',
    async () => {
      const port = await freePort()
      const release = await holdPort(port)

      await expect(holdPort(port)).rejects.toThrow(/EADDRINUSE/)

      await release()
    },
    HELPER_TIMEOUT_MS,
  )
})
