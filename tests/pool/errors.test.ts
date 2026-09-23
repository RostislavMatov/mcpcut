import { describe, expect, test } from 'vitest'
import {
  ERROR_CODE_POOL_INVALID_PARAMS,
  ERROR_CODE_POOL_MEMBER_GONE,
  ERROR_CODE_POOL_METHOD_NOT_FOUND,
  MAX_ERROR_NAME_CHARS,
} from '../../src/pool/constants.js'
import {
  poolCursorError,
  poolMemberGoneError,
  poolMethodNotFoundError,
  poolPingResult,
  safeNameOf,
} from '../../src/pool/errors.js'

/**
 * The replies the pool synthesizes itself. Everything here echoes something
 * the AGENT sent (a method it named, a server it prefixed), so every echo
 * goes through the same display hygiene — and every frame is one line with a
 * trailing newline, because framing is not negotiable.
 */

function decode(frame: Buffer): Record<string, unknown> {
  const text = frame.toString('utf8')
  expect(text.endsWith('\n')).toBe(true)
  expect(text.slice(0, -1)).not.toContain('\n')
  return JSON.parse(text) as Record<string, unknown>
}

describe('poolMethodNotFoundError', () => {
  test('answers a method the pool declares no capability for', () => {
    // Arrange / Act
    const body = decode(poolMethodNotFoundError(7, 'resources/list'))

    // Assert
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: { code: ERROR_CODE_POOL_METHOD_NOT_FOUND },
    })
    expect(JSON.stringify(body)).toContain('resources/list')
  })

  test('keeps a string id a string and a number id a number', () => {
    // The id is the agent's return address; changing its TYPE loses the
    // reply as surely as changing its value.
    expect(decode(poolMethodNotFoundError('abc', 'x'))['id']).toBe('abc')
    expect(decode(poolMethodNotFoundError(3, 'x'))['id']).toBe(3)
  })
})

describe('poolMemberGoneError', () => {
  test('tells a call its server has left the pool', () => {
    const body = decode(poolMemberGoneError(4, 'github'))

    expect(body).toMatchObject({ id: 4, error: { code: ERROR_CODE_POOL_MEMBER_GONE } })
  })

  test('uses a code distinct from every decision the plane makes', () => {
    // -32001 policy, -32002 approval, -32003 quarantine, -32004 bridge
    // transport. "The server left" is none of those, and an agent that
    // retried a policy denial would be wrong to retry this one the same way.
    expect(ERROR_CODE_POOL_MEMBER_GONE).toBe(-32005)
  })
})

describe('poolCursorError', () => {
  test('refuses a cursor the pool never issued', () => {
    // The pool drains its upstreams' pages itself and hands out no cursor of
    // its own (P6), so a cursor in a request is confusion or forgery.
    const body = decode(poolCursorError(9))

    expect(body).toMatchObject({ id: 9, error: { code: ERROR_CODE_POOL_INVALID_PARAMS } })
  })
})

describe('poolPingResult', () => {
  test('answers a ping with an empty result, not an error', () => {
    const body = decode(poolPingResult(2))

    expect(body).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
  })
})

describe('safeNameOf', () => {
  test('strips a bidi override that would make the text read backwards', () => {
    // Audit finding H2: a name a human reads in the journal or the console
    // must not be able to reorder the line around it.
    expect(safeNameOf('a‮gnp.exe')).toBe('agnp.exe')
  })

  test.each([
    ['C0 control', 'a\u0001b'],
    ['DEL', 'a\u007fb'],
    ['zero-width space', 'a​b'],
    ['BOM', 'a﻿b'],
  ])('strips a %s', (_label, input) => {
    expect(safeNameOf(input)).toBe('ab')
  })

  test('bounds the length so an echo cannot be a payload', () => {
    expect(safeNameOf('x'.repeat(5_000))).toHaveLength(MAX_ERROR_NAME_CHARS)
  })

  test('leaves an ordinary name exactly as it was', () => {
    expect(safeNameOf('github__create_issue')).toBe('github__create_issue')
  })

  test('never lets a hostile name reach an error frame unwashed', () => {
    const frame = poolMethodNotFoundError(1, 'tools/‮call')

    expect(frame.toString('utf8')).not.toContain('‮')
  })
})
