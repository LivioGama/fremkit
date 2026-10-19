import { createHmac, pbkdf2, timingSafeEqual } from 'node:crypto'

/**
 * How the code typed into the extension pairs it, without ever travelling.
 *
 * The Edge shows a code that only the real Fremkit can put there: with the helper, a server that
 * cannot answer `/auth/proof` never gets the kiosk to load its page. The user types that code into
 * the extension, and both ends prove they know it, the extension first:
 *
 * 1. the extension sends `nonceE` and `macE = HMAC(K, PAIR_CLIENT_LABEL + requestId | nonceE)`;
 * 2. the server checks it (three wrong ones refuse the request) and answers `nonceS`,
 *    `macS = HMAC(K, PAIR_SERVER_LABEL + requestId | nonceE | nonceS)` and the token;
 * 3. the extension keeps the token only if `macS` checks and came back within
 *    `PAIR_ANSWER_MS` of sending `macE`.
 *
 * The client first, so a program that made the request itself (an `Origin` is only a header to a
 * non-browser) gets one online guess per try and nothing to search offline. A program holding
 * Fremkit's port instead gets `macE` and could search the code offline, but not in time: about
 * 2^20 codes at 600 000 PBKDF2 rounds each is ~6·10^11 HMAC-SHA256, minutes on a large GPU and
 * hours on a CPU, against two seconds. `K = PBKDF2-SHA256(code, PAIR_SALT_PREFIX + requestId,
 * PAIR_KEY_ITERATIONS)`, the same function and cost as the iPad's `codeProof` (devices/codeProof.ts)
 * under a salt of its own, derived when the request is made so the real server answers at once.
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

/** How long the extension waits for the server's proof after sending its own. */
export const PAIR_ANSWER_MS = 2_000

const hmac = (key: Buffer, text: string): string => createHmac('sha256', key).update(text, 'utf8').digest('base64url')

/** base64url(HMAC-SHA256(K, PAIR_CLIENT_LABEL + requestId + "|" + nonceE)): the extension's proof. */
export function pairClientMac(key: Buffer, requestId: string, nonceE: string): string {
  return hmac(key, `${PAIR_CLIENT_LABEL}${requestId}|${nonceE}`)
}

/** base64url(HMAC-SHA256(K, PAIR_SERVER_LABEL + requestId + "|" + nonceE + "|" + nonceS)): the server's. */
export function pairServerMac(key: Buffer, requestId: string, nonceE: string, nonceS: string): string {
  return hmac(key, `${PAIR_SERVER_LABEL}${requestId}|${nonceE}|${nonceS}`)
}

/** Compares two macs in a time that does not depend on where they differ. */
export function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
