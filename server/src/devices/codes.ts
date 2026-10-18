import { randomInt, timingSafeEqual } from 'node:crypto'
import { expandIpv6 } from '../net/private.js'

/** No I, O, 0 or 1: a code is read off a screen and may be typed by hand. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 8
export const CODE_TTL_MS = 300_000
/**
 * Wrong codes allowed per minute from one peer (`peerKey`). Five is a typing mistake or two with
 * room to spare; counted per peer so that one guesser does not, by itself, lock the real iPad out.
 */
export const MAX_WRONG_PER_MINUTE = 5
/**
 * Wrong codes allowed per minute from every peer together, per code: the ceiling that keeps a
 * guesser with many addresses from multiplying the per-peer allowance.
 *
 * The numbers: a code is 8 characters from 32, so 32^8 ≈ 1.1 × 10^12 values, and lives 5 minutes.
 * At 60 wrong guesses a minute at most 300 are ever tried against one code, a chance of about
 * 3 × 10^-10 of hitting it. The ceiling is what a guesser with many IPv4 addresses (aliases on one
 * machine, or several machines) can still spend, holding pairing at 429 for everyone; issuing a new
 * code resets it (`issue`), since a new code is a new secret and the bound above is per code, so
 * the user always has a way out, and the guesser has to start over against the new one.
 */
export const MAX_WRONG_PER_MINUTE_TOTAL = 60

/**
 * Who a wrong guess is counted against: an IPv4 address (a mapped one read as the IPv4 it is), or
 * an IPv6 address's /64.
 *
 * Why the /64: inside its own /64 one IPv6 host picks any address it likes — SLAAC privacy
 * addresses, any `fe80::x` on the link — so counting per IPv6 address would give one machine as
 * many allowances as it cares to make. The /64 is the smallest prefix a host does not control. The
 * cost: IPv6 peers on the same network segment share one allowance, so a guesser there holds
 * pairing over IPv6 at 429 for that segment's IPv6 peers too; over IPv4 each address keeps its own.
 * Something unreadable is counted under itself.
 */
export function peerKey(address: string): string {
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%[^%]*$/, '')
  if (!ip.includes(':')) return ip
  const groups = expandIpv6(ip)
  if (!groups) return ip
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >>> 8, groups[6] & 0xff, groups[7] >>> 8, groups[7] & 0xff].join('.')
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`
}

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
 * Wrong guesses are counted per peer (`peerKey`) and in total. Once a peer's allowance is spent,
 * every attempt from it is refused — the right code included, or the limit would mean nothing —
 * until its minute is over; other peers go on. Once the total is spent, every attempt from
 * anyone is refused until that minute is over, or until a new code is issued.
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

  /**
   * Issues a fresh code, replacing any live one. The total is reset with it (a new secret, a new
   * per-code bound); the per-peer windows are kept, so a guesser is not handed a fresh allowance.
   */
  issue(): { code: string; expiresAt: number } {
    this.total.wrong = 0
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    this.live = { code, expiresAt: this.now() + CODE_TTL_MS }
    return { ...this.live }
  }

  /** True while a code is issued, unused and unexpired: the only time pairing is open at all. */
  hasLive(): boolean {
    return this.live !== null && this.now() <= this.live.expiresAt
  }

  /** `address` is the address the attempt came from, as the socket reports it. */
  consume(code: string, address = ''): ConsumeResult {
    const peer = peerKey(address)
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
