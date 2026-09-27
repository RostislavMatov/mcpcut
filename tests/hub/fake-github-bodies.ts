import type { IncomingMessage } from 'node:http'

/**
 * Request-body helpers for the fake GitHub (`./fake-github.ts`), split out
 * for the file-size rule. Node built-ins only, for the same reason as the
 * fake itself: `--serve` runs under type stripping.
 */

const MAX_REQUEST_BODY_BYTES = 16 * 1024

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_REQUEST_BODY_BYTES) chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/** GitHub accepts the exchange as a form or as JSON; so does the fake. */
export function parseBody(req: IncomingMessage, body: string): URLSearchParams {
  if ((req.headers['content-type'] ?? '').startsWith('application/json')) {
    const params = new URLSearchParams()
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') params.set(key, value)
      }
    } catch {
      // An unparsable body is simply an empty one: every check below fails.
    }
    return params
  }
  return new URLSearchParams(body)
}

export function accessTokenOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { access_token?: unknown }
    return typeof parsed.access_token === 'string' ? parsed.access_token : undefined
  } catch {
    return undefined
  }
}
