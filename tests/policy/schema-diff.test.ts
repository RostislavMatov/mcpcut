import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { SCHEMA_DIFF_MAX_CHANGES, SCHEMA_DIFF_MAX_DEPTH } from '../../src/policy/constants.js'
import { diffToolSchemas, type SchemaDiffResult } from '../../src/policy/schema-diff.js'

/**
 * Structural diff of two tool `inputSchema` values (M4 Task 5, backlog line
 * 45): the operator must see "property `force` was added" instead of "hashes
 * diverged". All inputs are treated as untrusted (they come from a server's
 * `tools/list`), so the diff must be total: never throw, never mutate, and
 * cap its own recursion/output.
 */

/** Recursively freezes a value so any mutation attempt throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as object)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

interface JsonObject {
  [key: string]: unknown
}

/** A realistic base `inputSchema` the table cases below mutate one facet of. */
function base(): JsonObject {
  return {
    type: 'object',
    description: 'Arguments for read_file',
    properties: {
      path: { type: 'string', description: 'File path to read' },
      mode: { type: 'string', enum: ['read', 'write'] },
    },
    required: ['path'],
  }
}

/** structuredClone + apply a patch function, keeping the original untouched. */
function variant(patch: (schema: JsonObject) => void): JsonObject {
  const copy = structuredClone(base())
  patch(copy)
  return copy
}

function props(schema: JsonObject): JsonObject {
  return schema['properties'] as JsonObject
}

describe('diffToolSchemas: table of structural changes', () => {
  const cases: ReadonlyArray<{
    name: string
    after: JsonObject
    change: { kind: string; path: string }
    delta: SchemaDiffResult['surfaceDelta']
  }> = [
    {
      name: 'new optional property → property-added / widened',
      after: variant((s) => {
        props(s)['force'] = { type: 'boolean' }
      }),
      change: { kind: 'property-added', path: 'properties.force' },
      delta: 'widened',
    },
    {
      name: 'removed property → property-removed / narrowed',
      after: variant((s) => {
        delete props(s)['mode']
      }),
      change: { kind: 'property-removed', path: 'properties.mode' },
      delta: 'narrowed',
    },
    {
      name: 'extended enum → enum-widened / widened',
      after: variant((s) => {
        ;(props(s)['mode'] as JsonObject)['enum'] = ['read', 'write', 'append']
      }),
      change: { kind: 'enum-widened', path: 'properties.mode.enum' },
      delta: 'widened',
    },
    {
      name: 'shrunk enum → enum-narrowed / narrowed',
      after: variant((s) => {
        ;(props(s)['mode'] as JsonObject)['enum'] = ['read']
      }),
      change: { kind: 'enum-narrowed', path: 'properties.mode.enum' },
      delta: 'narrowed',
    },
    {
      name: 'replaced enum members → enum-changed / changed',
      after: variant((s) => {
        ;(props(s)['mode'] as JsonObject)['enum'] = ['read', 'delete']
      }),
      change: { kind: 'enum-changed', path: 'properties.mode.enum' },
      delta: 'changed',
    },
    {
      name: 'changed type → type-changed / changed',
      after: variant((s) => {
        ;(props(s)['path'] as JsonObject)['type'] = 'number'
      }),
      change: { kind: 'type-changed', path: 'properties.path.type' },
      delta: 'changed',
    },
    {
      name: 'removed required entry → required-removed / widened',
      after: variant((s) => {
        s['required'] = []
      }),
      change: { kind: 'required-removed', path: 'required.path' },
      delta: 'widened',
    },
    {
      name: 'added required entry → required-added / narrowed',
      after: variant((s) => {
        s['required'] = ['path', 'mode']
      }),
      change: { kind: 'required-added', path: 'required.mode' },
      delta: 'narrowed',
    },
    {
      name: 'description-only edit → neutral',
      after: variant((s) => {
        ;(props(s)['path'] as JsonObject)['description'] = 'File path (absolute) to read'
      }),
      change: { kind: 'description-changed', path: 'properties.path.description' },
      delta: 'neutral',
    },
  ]

  test.each(cases)('$name', ({ after, change, delta }) => {
    const result = diffToolSchemas(deepFreeze(base()), deepFreeze(after))

    expect(result.truncated).toBe(false)
    expect(result.changes).toContainEqual(change)
    expect(result.surfaceDelta).toBe(delta)
  })

  test('identical schemas → no changes, neutral, not truncated', () => {
    const result = diffToolSchemas(deepFreeze(base()), deepFreeze(base()))

    expect(result).toEqual({ changes: [], surfaceDelta: 'neutral', truncated: false })
  })

  test('mixed widening and narrowing aggregates to changed', () => {
    const after = variant((s) => {
      props(s)['force'] = { type: 'boolean' } // widening
      delete props(s)['mode'] // narrowing
    })

    const result = diffToolSchemas(deepFreeze(base()), deepFreeze(after))

    expect(result.surfaceDelta).toBe('changed')
  })

  test('a neutral edit does not mask a widening one', () => {
    const after = variant((s) => {
      s['description'] = 'reworded'
      props(s)['force'] = { type: 'boolean' }
    })

    const result = diffToolSchemas(deepFreeze(base()), deepFreeze(after))

    expect(result.surfaceDelta).toBe('widened')
  })
})

describe('diffToolSchemas: untrusted / non-object inputs', () => {
  test('both schemas absent → neutral, no changes', () => {
    expect(diffToolSchemas(undefined, undefined)).toEqual({
      changes: [],
      surfaceDelta: 'neutral',
      truncated: false,
    })
  })

  test('schema appearing where none existed → a change with delta changed', () => {
    const result = diffToolSchemas(undefined, deepFreeze(base()))

    expect(result.changes.length).toBeGreaterThan(0)
    expect(result.surfaceDelta).toBe('changed')
  })

  test('schema replaced by a primitive → a change with delta changed', () => {
    const result = diffToolSchemas(deepFreeze(base()), 'not a schema')

    expect(result.changes.length).toBeGreaterThan(0)
    expect(result.surfaceDelta).toBe('changed')
  })

  test('null vs null → neutral', () => {
    expect(diffToolSchemas(null, null)).toEqual({
      changes: [],
      surfaceDelta: 'neutral',
      truncated: false,
    })
  })
})

describe('diffToolSchemas: caps (hostile input must not throw)', () => {
  function deepSchema(depth: number): unknown {
    let node: JsonObject = { type: 'string' }
    for (let i = 0; i < depth; i += 1) {
      node = { type: 'object', properties: { nested: node } }
    }
    return node
  }

  test('nesting beyond the depth cap → truncated: true, no exception', () => {
    const before = deepSchema(SCHEMA_DIFF_MAX_DEPTH + 40)
    const after = deepSchema(SCHEMA_DIFF_MAX_DEPTH + 40)
    ;(after as JsonObject)['description'] = 'still comparable at the top'

    const result = diffToolSchemas(deepFreeze(before), deepFreeze(after))

    expect(result.truncated).toBe(true)
  })

  test('more changes than the cap → truncated: true and a bounded change list', () => {
    const after = variant((s) => {
      for (let i = 0; i < SCHEMA_DIFF_MAX_CHANGES + 100; i += 1) {
        props(s)[`extra_${i}`] = { type: 'string' }
      }
    })

    const result = diffToolSchemas(deepFreeze(base()), deepFreeze(after))

    expect(result.truncated).toBe(true)
    expect(result.changes.length).toBeLessThanOrEqual(SCHEMA_DIFF_MAX_CHANGES)
    expect(result.surfaceDelta).toBe('widened')
  })
})

describe('diffToolSchemas: purity', () => {
  test('does not mutate its inputs (deep-frozen inputs, snapshot comparison)', () => {
    const before = base()
    const after = variant((s) => {
      props(s)['force'] = { type: 'boolean' }
    })
    const beforeSnapshot = structuredClone(before)
    const afterSnapshot = structuredClone(after)

    diffToolSchemas(deepFreeze(before), deepFreeze(after))

    expect(before).toEqual(beforeSnapshot)
    expect(after).toEqual(afterSnapshot)
  })

  test('is deterministic: same inputs give deep-equal results', () => {
    const after = variant((s) => {
      props(s)['force'] = { type: 'boolean' }
    })

    const first = diffToolSchemas(base(), after)
    const second = diffToolSchemas(base(), after)

    expect(first).toEqual(second)
  })

  test('module performs no I/O: no node: builtin imports in its source', async () => {
    const source = await readFile(
      join(__dirname, '..', '..', 'src', 'policy', 'schema-diff.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/from 'node:/)
    expect(source).not.toMatch(/require\(/)
  })
})
