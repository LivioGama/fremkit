import { describe, expect, it } from 'vitest'
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_TTL_MS,
  MAX_WRONG_PER_MINUTE,
  PairingCodes,
} from '../src/devices/codes.js'

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t }
  return c
}

/** A code of the right shape that is not `code`. */
function other(code: string): string {
  return code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'
}

describe('PairingCodes', () => {
  it('exposes the agreed constants', () => {
    expect(CODE_ALPHABET).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ23456789')
    expect(CODE_LENGTH).toBe(8)
    expect(CODE_TTL_MS).toBe(300_000)
    expect(MAX_WRONG_PER_MINUTE).toBe(5)
  })

  it('issues an 8-character code from the alphabet', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    for (let i = 0; i < 50; i++) {
      const { code, expiresAt } = codes.issue()
      expect(code).toHaveLength(8)
      for (const ch of code) expect(CODE_ALPHABET).toContain(ch)
      expect(expiresAt).toBe(c.t + CODE_TTL_MS)
    }
  })

  it('accepts a code once', () => {
    const codes = new PairingCodes(clock().now)
    const { code } = codes.issue()
    expect(codes.consume(code)).toBe('ok')
    expect(codes.consume(code)).toBe('wrong')
  })

  it('reports an expired code', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    const { code } = codes.issue()
    c.t += CODE_TTL_MS + 1
    expect(codes.consume(code)).toBe('expired')
  })

  it('accepts a code up to its last millisecond', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    const { code } = codes.issue()
    c.t += CODE_TTL_MS
    expect(codes.consume(code)).toBe('ok')
  })

  it('invalidates the previous code when a new one is issued', () => {
    const codes = new PairingCodes(clock().now)
    const first = codes.issue().code
    let second = codes.issue().code
    while (second === first) second = codes.issue().code
    expect(codes.consume(first)).toBe('wrong')
    expect(codes.consume(second)).toBe('ok')
  })

  it('refuses everything after 5 wrong codes in a minute, then recovers', () => {
    const c = clock()
    const codes = new PairingCodes(c.now)
    const { code } = codes.issue()
    expect(codes.guessing()).toBe(false)
    for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) {
      expect(codes.consume(other(code))).toBe('wrong')
      c.t += 1_000
    }
    expect(codes.consume(code)).toBe('limited')
    expect(codes.guessing()).toBe(true)

    c.t += 60_000
    expect(codes.guessing()).toBe(false)
    expect(codes.consume(code)).toBe('ok')
  })

  it('counts a guess with no live code as wrong', () => {
    const codes = new PairingCodes(clock().now)
    for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) expect(codes.consume('AAAAAAAA')).toBe('wrong')
    expect(codes.consume('AAAAAAAA')).toBe('limited')
  })

  it('clear() drops the live code', () => {
    const codes = new PairingCodes(clock().now)
    const { code } = codes.issue()
    codes.clear()
    expect(codes.consume(code)).toBe('wrong')
  })
})
