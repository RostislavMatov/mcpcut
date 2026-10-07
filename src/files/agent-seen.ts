import { searchAllSessions } from '../journal/search.js'
import { FILES_SERVER_NAME } from './constants.js'

/**
 * Whether the journal holds any decision of the files server for this agent,
 * `tools/list` included: that is what a first connect leaves behind. A journal
 * that cannot be read counts as "not seen" — the hint it feeds is harmless.
 */
export async function hasAgentConnected(agentName: string, dir?: string): Promise<boolean> {
  try {
    const result = await searchAllSessions({
      kind: 'decision',
      serverName: FILES_SERVER_NAME,
      agentName,
      limit: 1,
      ...(dir !== undefined ? { dir } : {}),
    })
    return result.hits.length > 0
  } catch {
    return false
  }
}
