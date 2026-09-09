import { describe, expect, test } from 'vitest'
import {
  ANY_OPTION,
  choiceField,
  choiceFlag,
  flagField,
  isOn,
  optionFlag,
  optionalChoice,
  patternField,
  positional,
  repeatedFlag,
  secretField,
  switchFlag,
  textField,
  valueOf,
} from '../../src/tui/catalogue/fields.js'

/**
 * The shared field constructors (phase 4, Task 3).
 *
 * Nine sections build their `argv` out of the same handful of shapes — an
 * optional flag, a repeated flag, a choice that may mean "don't ask" — and
 * these are those shapes written once. Every one is pure and returns a fresh
 * array or object, for the same reason `argv` must: what a section returns is
 * handed to `dispatch`, and a shared array would let one run rewrite another's
 * command line.
 */
describe('fields', () => {
  test('repeatedFlag splits on commas, trims, drops empties and repeats the flag', () => {
    expect(repeatedFlag({ env: ' A=1, ,B=vault:x ' }, 'env', '--env')).toEqual([
      '--env',
      'A=1',
      '--env',
      'B=vault:x',
    ])
  })

  test('repeatedFlag on an empty field says nothing at all', () => {
    expect(repeatedFlag({ env: '   ' }, 'env', '--env')).toEqual([])
    expect(repeatedFlag({}, 'env', '--env')).toEqual([])
  })

  test('choiceFlag omits the flag on ANY_OPTION and names it on anything else', () => {
    expect(choiceFlag({ protocol: ANY_OPTION }, 'protocol', '--protocol')).toEqual([])
    expect(choiceFlag({ protocol: 'stateless' }, 'protocol', '--protocol')).toEqual([
      '--protocol',
      'stateless',
    ])
  })

  test('optionalChoice offers ANY_OPTION first, so "not asked" is a value and not an empty widget', () => {
    const field = optionalChoice('protocol', 'Protocol', ['stateless', 'session'])

    expect(field.kind).toBe('choice')
    expect(field.options).toEqual([ANY_OPTION, 'stateless', 'session'])
  })

  test('choiceField offers exactly the options it is given, first one first', () => {
    // Arrange + Act
    const field = choiceField('service', 'Service', ['both', 'ui', 'serve'], 'both = ui, then serve')

    // Assert: no ANY_OPTION — every option here is a real answer
    expect(field.kind).toBe('choice')
    expect(field.options).toEqual(['both', 'ui', 'serve'])
    expect(field.options).not.toContain(ANY_OPTION)
    expect(field.hint).toBe('both = ui, then serve')
  })

  test('choiceField copies the options, so no section shares an array with another', () => {
    const options = ['ui', 'serve']

    expect(choiceField('service', 'Service', options).options).not.toBe(options)
  })

  test('choiceField without a hint carries no hint key at all', () => {
    expect('hint' in choiceField('service', 'Service', ['ui'])).toBe(false)
  })

  test('patternField refuses with the same sentence the Admins section uses', () => {
    const pattern = /^[a-z0-9][a-z0-9-]{0,63}$/
    const field = patternField('name', 'Name', pattern)

    expect(field.required).toBe(true)
    expect(field.hint).toBe(pattern.source)
    expect(field.validate?.('good-name')).toBeUndefined()
    expect(field.validate?.('Bad Name')).toBe(`must match ${pattern.source}`)
  })

  test('an empty optional field contributes nothing: no flag, no positional, no switch', () => {
    expect(optionFlag({ server: '' }, 'server', '--server')).toEqual([])
    expect(optionFlag({ server: 'files' }, 'server', '--server')).toEqual(['--server', 'files'])
    expect(switchFlag({ json: 'false' }, 'json', '--json')).toEqual([])
    expect(switchFlag({ json: 'true' }, 'json', '--json')).toEqual(['--json'])
    expect(positional({ name: '' }, 'name')).toEqual([])
    expect(positional({ name: 'files' }, 'name')).toEqual(['files'])
  })

  test('secretField is a required secret, so the renderer masks it and the form refuses it empty', () => {
    const field = secretField('secret', 'Secret', 'from stdin')

    expect(field.kind).toBe('secret')
    expect(field.required).toBe(true)
    expect(field.hint).toBe('from stdin')
  })

  test('flagField starts off, so a switch is never on because nobody looked at it', () => {
    const field = flagField('json', 'JSON')

    expect(field.kind).toBe('flag')
    expect(field.initial).toBeUndefined()
    expect(field.hint).toBeUndefined()
    expect(textField('server', 'Server').required).toBe(false)
  })

  test('valueOf and isOn read a missing field as empty and off, never as undefined', () => {
    expect(valueOf({}, 'missing')).toBe('')
    expect(valueOf({ name: 'files' }, 'name')).toBe('files')
    expect(isOn({}, 'json')).toBe(false)
    expect(isOn({ json: 'true' }, 'json')).toBe(true)
  })
})
