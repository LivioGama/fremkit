/**
 * The local access secret: what a request has to show before the server answers it.
 *
 * The server listens on loopback, and the Host and Origin checks in `guard.ts` stop a web page
 * from talking to it *as itself*. They do not stop a page from embedding or reading something
 * the browser lets through, and they cannot tell one local program from another. The secret
 * narrows "anything that can open a socket to 127.0.0.1" to "whoever can read a file only this
 * user can read": the helper that started the server, the scripts, and a browser that was handed
 * a one-time link by one of those.
 *
 * Two carriers, and nothing else:
 *
 * - `Authorization: Bearer <secret>`, for programs (the helper, the hook scripts, `curl`).
 * - A cookie holding the secret, `HttpOnly` and `SameSite=Strict`, for the pages. A browser gets
 *   it by following `/auth?code=…`, where the code is single-use, short-lived, and was minted by
 *   someone who already holds the secret. The helper writes the same cookie straight into its
 *   web views instead.
 *
 * A few routes are exempt, by route rather than by path text — see `isPublicRoute` and
 * `isCompanionRoute`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readCookie } from './cookies.js'

/** Bytes of randomness in a secret and in a one-time code. */
export const TOKEN_BYTES = 32
/** How long a one-time code stays redeemable. Long enough to open a browser, no longer. */
export const CODE_TTL_MS = 60_000
/** Codes waiting to be redeemed; minting past this drops the oldest. */
export const MAX_PENDING_CODES = 16

/** base64url, at least 32 bytes' worth (43 characters), and a ceiling so nothing absurd is held. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43,512}$/

/** A fresh secret or code: 32 random bytes, base64url. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** True for a string that can be a secret: base64url, at least 32 bytes of it. */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value)
}

/**
 * The cookie's name, which carries the port.
 *
 * Browsers scope cookies by host and *not* by port, so the live server on 4242 and a second
 * checkout on 4301 would overwrite each other's cookie if both used one name, logging each other
 * out on every visit.
 */
export function cookieName(port?: number): string {
  return port === undefined ? 'fremkit_access' : `fremkit_access_${port}`
}

/**
 * Compares two strings in time that does not depend on where they differ.
 *
 * Both sides are hashed first, so the comparison is always over 32 bytes and a length mismatch
 * says nothing either.
 */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}

export { readCookie }

/** The token of an `Authorization: Bearer …` header, or undefined. */
export function readBearer(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw !== 'string') return undefined
  const m = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(raw)
  return m?.[1]
}

/**
 * The routes that answer without the secret.
 *
 * - `/auth` is where the secret is *obtained*; it takes a one-time code instead.
 * - `/fremkit.js` and `/widgets/:id/*` are the widgets' own files. A widget runs in a sandboxed
 *   iframe with an opaque origin, and a browser treats every request such a document makes — its
 *   scripts, its styles, its images, the bridge itself — as cross-site, so a `SameSite=Strict`
 *   cookie is never sent with them. These files are the same bytes as the repository or the
 *   registry publishes, carry no user data, and are served under the widget CSP whatever opens
 *   them. Everything a widget *does* goes through the host page, which holds the cookie.
 *
 * Decided on the route Fastify matched, not on the request's path text: a path that merely
 * *starts* with `/widgets/` but is routed somewhere else (dot segments, encodings) is not exempt.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set(['/auth', '/fremkit.js', '/widgets/:id/*'])

export function isPublicRoute(method: string, routeUrl: string | undefined): boolean {
  const m = method.toUpperCase()
  if (m !== 'GET' && m !== 'HEAD') return false
  return routeUrl !== undefined && PUBLIC_ROUTES.has(routeUrl)
}

/**
 * The routes the browser extension reaches without the secret, as `METHOD url-pattern`.
 *
 * An extension cannot read a file only this user can read, so it pairs instead: it asks
 * (`POST /api/companion/pair`), the user approves on the Edge or in the admin, and it collects
 * its own token (`GET /api/companion/pair/:requestId`), which the socket (`/companion/ws`) then
 * asks for. Each of these checks the extension's origin itself, and the Host check still applies.
 * Approving and refusing are not here: they stay behind the secret.
 *
 * Matched on the method and the route Fastify matched, like `PUBLIC_ROUTES`.
 */
export const COMPANION_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/companion/pair',
  'GET /api/companion/pair/:requestId',
  'GET /companion/ws',
])

export function isCompanionRoute(method: string, routeUrl: string | undefined): boolean {
  return routeUrl !== undefined && COMPANION_ROUTES.has(`${method.toUpperCase()} ${routeUrl}`)
}

/**
 * Where `/auth` may send the browser afterwards: a path on this server, nothing else.
 *
 * `//evil.example` and `/\evil.example` are protocol-relative to a browser, so a second slash or
 * a backslash right after the first is refused, as is anything with a control character.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 2048) return '/'
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return '/'
  return next
}

export interface AccessGateOptions {
  /** The port the server listens on, which names the cookie. */
  port?: number
  /** A clock, for the tests. */
  now?: () => number
}

/** The secret, the one-time codes it mints, and the checks a request goes through. */
export class AccessGate {
  readonly cookie: string
  private readonly now: () => number
  /** Pending one-time codes and when each stops being valid, oldest first. */
  private readonly codes = new Map<string, number>()

  constructor(private readonly token: string, opts: AccessGateOptions = {}) {
    if (!isWellFormedToken(token)) throw new Error('the access secret is not a base64url string of at least 32 bytes')
    this.cookie = cookieName(opts.port)
    this.now = opts.now ?? Date.now
  }

  /** True when the request carries the secret, as a bearer token or as our cookie. */
  isAuthorized(headers: { authorization?: string | string[]; cookie?: string | string[] }): boolean {
    const bearer = readBearer(headers.authorization)
    if (bearer !== undefined && safeEqual(bearer, this.token)) return true
    const cookie = readCookie(headers.cookie, this.cookie)
    return cookie !== undefined && safeEqual(cookie, this.token)
  }

  /** A new one-time code, valid for `CODE_TTL_MS`. */
  mintCode(): string {
    this.sweep()
    while (this.codes.size >= MAX_PENDING_CODES) {
      const oldest = this.codes.keys().next().value
      if (oldest === undefined) break
      this.codes.delete(oldest)
    }
    const code = generateToken()
    this.codes.set(code, this.now() + CODE_TTL_MS)
    return code
  }

  /**
   * True once for a code that was minted and has not expired; the code is gone afterwards,
   * whether it worked or not. The lookup walks every pending code with `safeEqual` rather than
   * asking the map, so how long it takes says nothing about which codes exist.
   */
  redeem(code: unknown): boolean {
    this.sweep()
    if (typeof code !== 'string' || !isWellFormedToken(code)) return false
    let found: string | undefined
    for (const pending of this.codes.keys()) {
      if (safeEqual(pending, code)) found = pending
    }
    if (found === undefined) return false
    this.codes.delete(found)
    return true
  }

  /** The `Set-Cookie` value that hands the secret to a browser. A session cookie: no expiry. */
  setCookieHeader(): string {
    return `${this.cookie}=${this.token}; Path=/; HttpOnly; SameSite=Strict`
  }

  private sweep(): void {
    const now = this.now()
    for (const [code, expires] of this.codes) {
      if (expires <= now) this.codes.delete(code)
    }
  }
}
