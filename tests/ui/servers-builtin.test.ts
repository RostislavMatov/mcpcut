import { describe, expect, test } from 'vitest'
import { serverRecordToForm } from '../../src/ui/server-form.js'
import { renderServersPage } from '../../src/ui/pages/servers.js'
import { serverRecordSchema } from '../../src/registry/schema.js'

const OWNER = { name: 'alice', role: 'owner' } as const
const record = serverRecordSchema.parse({ name: 'files', transport: 'builtin', kind: 'files' })

function page(): string {
  return renderServersPage({ servers: [record], canManage: true, csrfToken: 'csrf-token-value', currentAdmin: OWNER })
}

describe('servers page: builtin files server', () => {
  test('the card is read-only: no Edit link, an explanation and the next step instead of command fields', () => {
    const html = page()
    expect(html).toContain('built-in file server')
    expect(html).toContain('mcpcut files grant')
    expect(html).not.toContain('edit=files')
    expect(html).not.toContain('class="label">command')
    expect(html).not.toContain('class="label">url')
  })

  test('the edit form for a builtin record is blank, never a command to change', () => {
    const form = serverRecordToForm(record)
    expect(form.transport).toBe('builtin')
    expect(form.command).toBe('')
    expect(form.url).toBe('')
  })
})
