import { createHmac, pbkdf2, timingSafeEqual } from 'node:crypto'

/**
 * How the code typed into the extension pairs it, without ever travelling.
 *
 * The Edge shows a code that only the real Fremkit can put there: with the helper, a server that
 * cannot answer `/auth/proof` never gets the kiosk to load its page. The user types that code into
 * the extension, and both ends prove they know it, the server first:
 *
 * 1. the extension sends `nonceE`; the server answers `nonceS` and
 *    `macS = HMAC(K, PAIR_SERVER_LABEL + requestId | nonceE | nonceS)`;
 * 2. the extension recomputes `macS` from the typed code; only when it matches does it send
 *    `macE = HMAC(K, PAIR_CLIENT_LABEL + …the same fields)`, and the server hands out the token.
 *
 * Server first, because a program holding Fremkit's port plays the server: it never sees a `macE`
 * unless it already knew the code, so it gets one online guess per attempt and nothing to grind
 * offline. `K = PBKDF2-SHA256(code, PAIR_SALT_PREFIX + requestId, PAIR_KEY_ITERATIONS)`, the same
 * function and cost as the iPad's `codeProof` (devices/codeProof.ts) under a salt of its own, so a
 * value made for one never serves the other.
 *
 * Mirrored by companion/lib/pairProof.js; both test the same vector.
 */
export const PAIR_KEY_ITERATIONS = 600_000
export const PAIR_SALT_PREFIX = 'fremkit-companion-pair-code-v1:'
export const PAIR_SERVER_LABEL = 'fremkit-companion-pair-server-v1|'
export const PAIR_CLIENT_LABEL = 'fremkit-companion-pair-client-v1|'

/** K(code) for one request: 32 bytes. Asynchronous, so 600 000 rounds never block the event loop. */
export function pairKey(code: string, requestId: string, iterations = PAIR_KEY_ITERATIONS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(code, PAIR_SALT_PREFIX + requestId, iterations, 32, 'sha256', (err, key) => (err ? reject(err) : resolve(key)))
  })
}

/** base64url(HMAC-SHA256(key, label + requestId + "|" + nonceE + "|" + nonceS)). */
export function pairMac(key: Buffer, label: string, requestId: string, nonceE: string, nonceS: string): string {
  return createHmac('sha256', key).update(`${label}${requestId}|${nonceE}|${nonceS}`, 'utf8').digest('base64url')
}

/** Compares two macs in a time that does not depend on where they differ. */
export function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
