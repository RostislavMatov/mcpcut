import { describe, expect, test } from 'vitest'
import type { UiSession } from '../../src/ui/auth.js'
import { renderAgentsPage } from '../../src/ui/pages/agents.js'
import { renderFilesPage } from '../../src/ui/pages/files.js'
import type { FilesView } from '../../src/ui/pages/files-view.js'
import { renderApprovalsPage } from '../../src/ui/pages/approvals.js'
import { renderServersPage } from '../../src/ui/pages/servers.js'

/**
 * An empty screen says how to fill it (owner's rule 2026-09-29): a link to the
 * action that exists on this install, or — for an admin who may not take it —
 * who can. The old first sentence stays, so the screen still says what it is.
 */

function session(role: UiSession['role']): UiSession {
  return { adminName: 'alice', role, csrfToken: 'csrf' }
}

function serversPage(role: UiSession['role']): string {
  const s = session(role)
  return renderServersPage({
    servers: [],
    canManage: role === 'owner',
    csrfToken: s.csrfToken,
    currentAdmin: { name: s.adminName, role: s.role },
  })
}

describe('empty screens name the next step', () => {
  test('no servers: an owner gets the register link', () => {
    const page = serversPage('owner')
    // Inside the empty state itself, not only in the nav.
    expect(page).toMatch(/<p class="empty">No servers registered\.[^<]*<a href="\/servers\?add=1#add-server">/)
  })

  test('no servers: a viewer is told an owner registers them', () => {
    const page = serversPage('viewer')
    expect(page).toContain('No servers registered.')
    expect(page).toContain('An owner registers')
    expect(page).not.toMatch(/<p class="empty">[^<]*<a href="\/servers\?add=1#add-server">/)
  })

  test('no agents: an owner gets the create drawer', () => {
    const page = renderAgentsPage({ serveAddress: 'http://127.0.0.1:8090', agents: [], session: session('owner') })
    expect(page).toMatch(/<p class="empty">No agents yet\.(?:[^<]|<code>[^<]*<\/code>)*<a href="#create-agent" data-open-details="create-agent">/)
  })

  test('no agents: a viewer is told an owner creates them', () => {
    const page = renderAgentsPage({ serveAddress: 'http://127.0.0.1:8090', agents: [], session: session('viewer') })
    expect(page).toContain('An owner creates')
  })

  test('no pending approvals: says what puts a call here and where to set it', () => {
    const page = renderApprovalsPage({ cards: [], csrfToken: 'c' })
    expect(page).toContain('No pending approvals.')
    expect(page).toContain('require-approval')
    expect(page).toContain('href="/servers"')
  })

  function emptyFilesPage(role: UiSession['role']): string {
    const view: FilesView = {
      session: session(role),
      canManage: role === 'owner',
      folders: [],
      access: { agents: [], groups: [] },
      trash: [],
      audit: { filters: { path: '', agent: '', since: '7d' }, agents: [], isUnfiltered: true },
    }
    return renderFilesPage(view)
  }

  test('no folders: an owner gets the ready declare command', () => {
    const page = emptyFilesPage('owner')
    expect(page).toMatch(/<p class="empty">No folders yet\. Declare one agents may reach:<\/p><pre class="ag-config"[^>]*>[^<]*files root add &lt;folder&gt;<\/pre>/)
  })

  test('no folders: a viewer is told an owner declares them', () => {
    const page = emptyFilesPage('viewer')
    expect(page).toContain('No folders yet. An owner declares them.')
    expect(page).not.toContain('files root add')
  })

  test('empty trash says how long deletions stay', () => {
    expect(emptyFilesPage('viewer')).toContain('Nothing in the trash. What agents delete stays here for 30 days.')
  })
})
