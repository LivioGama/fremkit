import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { CODE_ALPHABET } from '../devices/codes.js'
import type { DeviceStore } from '../devices/store.js'

/** Short enough to read off the Edge at a glance; the user compares it, nobody types it. */
export const MATCH_CODE_LENGTH = 4
export const REQUEST_TTL_MS = 120_000
/** Requests accepted per minute, from every extension together. */
export const MAX_REQUESTS_PER_MINUTE = 5
/** Requests accepted per minute from one install, on top of the global count. */
export const MAX_REQUESTS_PER_INSTALL_PER_MINUTE = 3
/** How long an install whose request was refused is turned away. */
export const REFUSED_COOLDOWN_MS = 60_000

const WINDOW_MS = 60_000

type Answerable = { result: 'notFound' | 'changed' } | { req: PairRequest }

/** Compares two codes in a time that does not depend on where they differ. */
function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Why a request was not taken. */
export type RequestRefusal = 'limited' | 'busy' | 'cooldown'

/** `changed`: the request on show is not the one answered, or the code given is not its code. */
export type AnswerResult = 'ok' | 'notFound' | 'changed'

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
 * One request waits for an answer at a time, and nothing else takes its place: a new request from
 * the same install replaces it (the extension asking again after its popup reopened), one from any
 * other install is turned away as `busy` until the waiting one is answered or expires. The answer
 * names the code it was given for, so a request swapped in after the user read the code is never
 * the one approved. Once answered, a request is kept until it expires, two minutes after it was
 * made, so the extension can collect the answer — the token of an approved one exactly once. A
 * token nobody collected goes when the request does, and so does its device record.
 *
 * Requests are counted globally, like wrong pairing codes: an origin is only a name the asker
 * picks, so a per-origin count would limit nothing. The per-install count and the cooldown after a
 * refusal only keep one honest extension from hammering; a local process can pick any install id,
 * and what protects the user is comparing the code in the popup with the one on the Edge.
 *
 * Nothing here logs: the code and the token are secrets, and the routes log the events.
 */
export class CompanionPairing {
  private readonly requests = new Map<string, PairRequest>()
  private waiting: string | null = null
  private accepted: number[] = []
  private readonly acceptedByInstall = new Map<string, number[]>()
  /** installId → when its request was refused. */
  private readonly refusedAt = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: DeviceStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  request(input: { origin: string; name: string; installId: string }): { requestId: string; code: string; expiresAt: number } | RequestRefusal {
    const now = this.now()
    this.sweep(now)
    const refused = this.refusedAt.get(input.installId)
    if (refused !== undefined && now - refused < REFUSED_COOLDOWN_MS) return 'cooldown'
    const waiting = this.waiting === null ? undefined : this.requests.get(this.waiting)
    if (waiting && (waiting.installId !== input.installId || waiting.origin !== input.origin)) return 'busy'
    this.accepted = this.accepted.filter((t) => now - t < WINDOW_MS)
    if (this.accepted.length >= MAX_REQUESTS_PER_MINUTE) return 'limited'
    const mine = (this.acceptedByInstall.get(input.installId) ?? []).filter((t) => now - t < WINDOW_MS)
    if (mine.length >= MAX_REQUESTS_PER_INSTALL_PER_MINUTE) return 'limited'
    this.accepted.push(now)
    mine.push(now)
    this.acceptedByInstall.set(input.installId, mine)

    // Only ever the same install's own request: another install's was turned away above.
    if (waiting) this.requests.delete(waiting.requestId)
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

  /**
   * Pairs the waiting request's extension, if `code` is the one it shows. `notFound` when nothing
   * waits; `changed` when another request waits now, or the code is not this request's — the user
   * read the code of a request that is no longer the one on show.
   */
  async approve(requestId: string, code: unknown): Promise<AnswerResult> {
    const found = this.answerable(requestId, code)
    if ('result' in found) return found.result
    const req = found.req
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
    return 'ok'
  }

  /** Refuses the waiting request, on the same terms as `approve`; its install waits a minute to ask again. */
  refuse(requestId: string, code: unknown): AnswerResult {
    const found = this.answerable(requestId, code)
    if ('result' in found) return found.result
    found.req.state = 'refused'
    this.waiting = null
    this.refusedAt.set(found.req.installId, this.now())
    this.changed()
    return 'ok'
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

  private answerable(requestId: string, code: unknown): Answerable {
    this.sweep(this.now())
    const waiting = this.waiting === null ? undefined : this.requests.get(this.waiting)
    if (!waiting || waiting.state !== 'pending') return { result: 'notFound' }
    if (waiting.requestId !== requestId || typeof code !== 'string' || !sameCode(code, waiting.code)) return { result: 'changed' }
    return { req: waiting }
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
    for (const [installId, at] of this.refusedAt) if (now - at >= REFUSED_COOLDOWN_MS) this.refusedAt.delete(installId)
    for (const [installId, times] of this.acceptedByInstall) {
      if (times.every((t) => now - t >= WINDOW_MS)) this.acceptedByInstall.delete(installId)
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
