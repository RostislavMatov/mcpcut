import { describe, expect, test } from 'vitest'
import { GUIDE_URL } from '../../src/brand.js'
import { statelessInitializeRefusal } from '../../src/cli/connect-constants.js'
import { protocolMismatchRefusal, SESSION_MODELS_GUIDE_URL } from '../../src/cli/serve-constants.js'

/**
 * A session-model refusal ends with where to read about it. The reader is in a
 * terminal with an npm install, not a checkout, so the pointer must be the
 * published guide's URL — never a repository path, let alone one the public
 * repository does not carry.
 */
describe('session-model refusals point at the published guide', () => {
  const SERVE_AND_POOL = `${GUIDE_URL}/serve-and-pool.md`

  test('serve: a downstream/upstream mismatch names the guide page', () => {
    // Act
    const text = protocolMismatchRefusal('stateless', 'github', 'registered as a sessionful HTTP server')

    // Assert
    expect(text).toContain(SERVE_AND_POOL)
    expect(text).not.toContain('docs/adr')
  })

  test('connect: initialize against a stateless server names the guide page', () => {
    // Act
    const text = statelessInitializeRefusal('github')

    // Assert
    expect(text).toContain(SERVE_AND_POOL)
    expect(text).not.toContain('docs/adr')
  })
})

test('the spelled-out session-models URL is the guide URL plus the page', () => {
  expect(SESSION_MODELS_GUIDE_URL).toBe(`${GUIDE_URL}/serve-and-pool.md`)
})
