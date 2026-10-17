import { randomInt, timingSafeEqual } from 'node:crypto'

/** No I, O, 0 or 1: a code is read off a screen and may be typed by hand. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 8
export const CODE_TTL_MS = 300_000
/** Wrong codes allowed per minute, across every client together. */
export const MAX_WRONG_PER_MINUTE = 5

const WINDOW_MS = 60_000

export type ConsumeResult = 'ok' | 'wrong' | 'expired' | 'limited'

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * The pairing code shown on the Mac: one live code at a time, single use, five minutes long.
 *
 * Wrong guesses are counted globally rather than per client, since a client is only an address
 * the guesser controls. Once the minute's allowance is spent, every attempt is refused, the
 * right code included, until the minute that began with the first wrong guess is over.
 */
export class PairingCodes {
  private live: { code: string; expiresAt: number } | null = null
  private windowStart = 0
  private wrong = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Issues a fresh code, replacing any live one. */
  issue(): { code: string; expiresAt: number } {
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    this.live = { code, expiresAt: this.now() + CODE_TTL_MS }
    return { ...this.live }
  }

  consume(code: string): ConsumeResult {
    const now = this.now()
    this.rollWindow(now)
    if (this.wrong >= MAX_WRONG_PER_MINUTE) return 'limited'
    const live = this.live
    if (live && sameCode(code, live.code)) {
      this.live = null
      return now > live.expiresAt ? 'expired' : 'ok'
    }
    if (this.wrong === 0) this.windowStart = now
    this.wrong++
    return 'wrong'
  }

  /** True while the minute's allowance of wrong codes is spent. */
  guessing(): boolean {
    this.rollWindow(this.now())
    return this.wrong >= MAX_WRONG_PER_MINUTE
  }

  /** Drops the live code. The guess counter is kept, so clearing is no way around the limit. */
  clear(): void {
    this.live = null
  }

  private rollWindow(now: number): void {
    if (this.wrong > 0 && now - this.windowStart >= WINDOW_MS) this.wrong = 0
  }
}
