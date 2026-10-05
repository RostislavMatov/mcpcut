import { expect, test } from 'vitest'
import { FilesDbError } from '../../../src/files/db/errors.js'
import { resolveSchema } from '../../../src/files/db/schema-env.js'

test('the default, the environment and the seam, in that order of weakness', () => {
  expect(resolveSchema({})).toBe('mcpcut')
  expect(resolveSchema({ env: { MCPCUT_FILES_DB_SCHEMA: 'tmp_one' } })).toBe('tmp_one')
  expect(resolveSchema({ env: { MCPCUT_FILES_DB_SCHEMA: '' } })).toBe('mcpcut')
  expect(resolveSchema({ schema: 'seam', env: { MCPCUT_FILES_DB_SCHEMA: 'tmp_one' } })).toBe('seam')
})

test.each(['Bad-Name', 'a b', '1abc', 'x;drop'])('%j is refused with a FilesDbError', (name) => {
  expect(() => resolveSchema({ env: { MCPCUT_FILES_DB_SCHEMA: name } })).toThrow(FilesDbError)
})
