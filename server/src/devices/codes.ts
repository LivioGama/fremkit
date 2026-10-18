import { randomInt, timingSafeEqual } from 'node:crypto'

/** No I, O, 0 or 1: a code is read off a screen and may be typed by hand. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 8
export const CODE_TTL_MS = 300_000
/**
 * Wrong codes allowed per minute from one peer address. Five is a typing mistake or two with room
 * to spare; it is per address so that one machine guessing cannot lock the real iPad out.
 */
export const MAX_WRONG_PER_MINUTE = 5
/**
 * Wrong codes allowed per minute from every peer together: the ceiling that keeps a guesser with
 * many addresses from multiplying the per-address allowance.
 *
 * The numbers: a code is 8 characters from 32, so 32^8 ≈ 1.1 × 10^12 values, and lives 5 minutes.
 * At 60 wrong guesses a minute at most 300 are ever tried against one code, a chance of about
 * 3 × 10^-10 of hitting it. Twelve addresses at the per-peer limit reach the ceiling, and only then
 * is everyone refused for the rest of the minute: a lock-out now takes a dozen machines on the
 * local network (the listener answers nothing else, see `net/lan.ts`), not one.
 */
export const MAX_WRONG_PER_MINUTE_TOTAL = 60

const WINDOW_MS = 60_000

export type ConsumeResult = 'ok' | 'wrong' | 'expired' | 'limited'

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A count of wrong guesses in a minute that began with the first of them. */
class Window {
  start = 0
  wrong = 0
  roll(now: number): void {
    if (this.wrong > 0 && now - this.start >= WINDOW_MS) this.wrong = 0
  }
  add(now: number): void {
    if (this.wrong === 0) this.start = now
    this.wrong++
  }
}

/**
 * The pairing code shown on the Mac: one live code at a time, single use, five minutes long.
 *
 * Wrong guesses are counted per peer address and in total. Once a peer's allowance is spent,
 * every attempt from it is refused — the right code included, or the limit would mean nothing —
 * until its minute is over; other peers go on. Once the total is spent, every attempt from
 * anyone is refused until that minute is over.
 */
export class PairingCodes {
  private live: { code: string; expiresAt: number } | null = null
  private readonly total = new Window()
  /**
   * Per peer. Bounded without a cap of its own: an entry is only made by a wrong guess the total
   * allowed, so at most `MAX_WRONG_PER_MINUTE_TOTAL` a minute, and spent ones are dropped.
   */
  private readonly peers = new Map<string, Window>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Issues a fresh code, replacing any live one. */
  issue(): { code: string; expiresAt: number } {
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    this.live = { code, expiresAt: this.now() + CODE_TTL_MS }
    return { ...this.live }
  }

  /** True while a code is issued, unused and unexpired: the only time pairing is open at all. */
  hasLive(): boolean {
    return this.live !== null && this.now() <= this.live.expiresAt
  }

  /** `peer` is the address the attempt came from, as the socket reports it. */
  consume(code: string, peer = ''): ConsumeResult {
    const now = this.now()
    this.roll(now)
    const own = this.peers.get(peer)
    if (this.total.wrong >= MAX_WRONG_PER_MINUTE_TOTAL) return 'limited'
    if (own && own.wrong >= MAX_WRONG_PER_MINUTE) return 'limited'
    const live = this.live
    if (live && sameCode(code, live.code)) {
      this.live = null
      return now > live.expiresAt ? 'expired' : 'ok'
    }
    this.total.add(now)
    let window = own
    if (!window) this.peers.set(peer, (window = new Window()))
    window.add(now)
    return 'wrong'
  }

  /** True while someone is being refused for guessing: one peer or everyone. */
  guessing(): boolean {
    this.roll(this.now())
    if (this.total.wrong >= MAX_WRONG_PER_MINUTE_TOTAL) return true
    for (const w of this.peers.values()) if (w.wrong >= MAX_WRONG_PER_MINUTE) return true
    return false
  }

  /** Drops the live code. The guess counters are kept, so clearing is no way around the limit. */
  clear(): void {
    this.live = null
  }

  private roll(now: number): void {
    this.total.roll(now)
    for (const [peer, w] of this.peers) {
      w.roll(now)
      if (w.wrong === 0) this.peers.delete(peer)
    }
  }
}
