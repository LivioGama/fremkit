import { randomInt, randomUUID } from 'node:crypto'
import { CODE_ALPHABET } from '../devices/codes.js'
import type { DeviceStore } from '../devices/store.js'

/** Short enough to read off the Edge at a glance; the user compares it, nobody types it. */
export const MATCH_CODE_LENGTH = 4
export const REQUEST_TTL_MS = 120_000
/** Requests accepted per minute, from every extension together. */
export const MAX_REQUESTS_PER_MINUTE = 5

const WINDOW_MS = 60_000

export type CollectResult =
  | { state: 'pending' | 'refused' | 'expired' }
  | { state: 'approved'; token: string; deviceId: string }

interface PairRequest {
  requestId: string
  code: string
  name: string
  origin: string
  installId: string
  expiresAt: number
  /** `approving` while the device record is being written; the extension is told `pending`. */
  state: 'pending' | 'approving' | 'approved' | 'refused'
  token?: string
  deviceId?: string
}

/**
 * A browser extension asking to pair, and the user's answer.
 *
 * One request waits for an answer at a time: a new one replaces it. Once answered, a request is
 * kept until it expires, two minutes after it was made, so the extension can collect the answer —
 * the token of an approved one exactly once. A token nobody collected goes when the request does, and so does its device record.
 *
 * Requests are counted globally, like wrong pairing codes: an origin is only a name the asker
 * picks, so a per-origin count would limit nothing.
 *
 * Nothing here logs: the code and the token are secrets, and the routes log the events.
 */
export class CompanionPairing {
  private readonly requests = new Map<string, PairRequest>()
  private waiting: string | null = null
  private accepted: number[] = []
  private readonly listeners = new Set<() => void>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: DeviceStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  request(input: { origin: string; name: string; installId: string }): { requestId: string; code: string; expiresAt: number } | 'limited' {
    const now = this.now()
    this.sweep(now)
    this.accepted = this.accepted.filter((t) => now - t < WINDOW_MS)
    if (this.accepted.length >= MAX_REQUESTS_PER_MINUTE) return 'limited'
    this.accepted.push(now)

    if (this.waiting !== null) this.requests.delete(this.waiting)
    let code = ''
    for (let i = 0; i < MATCH_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    const req: PairRequest = {
      requestId: randomUUID(),
      code,
      name: input.name,
      origin: input.origin,
      installId: input.installId,
      expiresAt: now + REQUEST_TTL_MS,
      state: 'pending',
    }
    this.requests.set(req.requestId, req)
    this.waiting = req.requestId
    this.armTimer()
    this.changed()
    return { requestId: req.requestId, code: req.code, expiresAt: req.expiresAt }
  }

  /** The request waiting for the user's answer, for the Edge and the admin to show. */
  pending(): { requestId: string; code: string; name: string; expiresAt: number } | null {
    this.sweep(this.now())
    const req = this.waiting === null ? undefined : this.requests.get(this.waiting)
    return req ? { requestId: req.requestId, code: req.code, name: req.name, expiresAt: req.expiresAt } : null
  }

  /** Pairs the waiting request's extension. False when it is not the waiting one, or has expired. */
  async approve(requestId: string): Promise<boolean> {
    const req = this.answerable(requestId)
    if (!req) return false
    // Taken off the waiting slot first, so a second approve or a refuse cannot race this one.
    req.state = 'approving'
    this.waiting = null
    try {
      const { device, token } = await this.store.createExtension({ name: req.name, origin: req.origin, installId: req.installId })
      req.token = token
      req.deviceId = device.id
      req.state = 'approved'
    } catch (err) {
      this.requests.delete(requestId)
      this.changed()
      throw err
    }
    this.changed()
    return true
  }

  refuse(requestId: string): boolean {
    const req = this.answerable(requestId)
    if (!req) return false
    req.state = 'refused'
    this.waiting = null
    this.changed()
    return true
  }

  /** False when the request exists and was made from another origin. */
  belongsTo(requestId: string, origin: string): boolean {
    const req = this.requests.get(requestId)
    return req === undefined || req.origin === origin
  }

  /**
   * The answer to a request, for the origin that made it. An approved request hands its token out
   * once and is gone afterwards; an unknown, replaced or expired one is `expired`. Another origin
   * is refused and leaves the request as it was.
   */
  collect(requestId: string, origin: string): CollectResult {
    this.sweep(this.now())
    const req = this.requests.get(requestId)
    if (!req) return { state: 'expired' }
    if (req.origin !== origin) return { state: 'refused' }
    if (req.state === 'approved' && req.token !== undefined && req.deviceId !== undefined) {
      this.requests.delete(requestId)
      this.changed()
      return { state: 'approved', token: req.token, deviceId: req.deviceId }
    }
    return { state: req.state === 'refused' ? 'refused' : 'pending' }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Stops the expiry timer. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private answerable(requestId: string): PairRequest | null {
    this.sweep(this.now())
    if (requestId !== this.waiting) return null
    const req = this.requests.get(requestId)
    return req && req.state === 'pending' ? req : null
  }

  /** Drops every expired request, and says so once when there was any. */
  private sweep(now: number): void {
    let dropped = false
    for (const [id, req] of this.requests) {
      // An approval still writing its record is left alone: it is about to be collectable.
      if (req.state !== 'approving' && now >= req.expiresAt) {
        this.requests.delete(id)
        if (this.waiting === id) this.waiting = null
        // An approved answer nobody collected leaves a paired device whose token is lost for good.
        if (req.state === 'approved' && req.token !== undefined && req.deviceId !== undefined) {
          this.store.remove(req.deviceId).catch(() => { /* the list shows it; the user can remove it */ })
        }
        dropped = true
      }
    }
    if (dropped) this.changed()
  }

  /** Notices the waiting request's expiry without waiting for somebody to ask. */
  private armTimer(): void {
    this.dispose()
    this.timer = setTimeout(() => {
      this.timer = null
      this.sweep(this.now())
    }, REQUEST_TTL_MS + 50)
    this.timer.unref()
  }

  private changed(): void {
    for (const cb of this.listeners) {
      try {
        cb()
      } catch {
        // A listener's failure is its own; the others still hear about the change.
      }
    }
  }
}
