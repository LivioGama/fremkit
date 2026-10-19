// Pairing by the code the user types from the Edge. It mirrors server/src/companion/pairProof.ts:
// keep the two in step (both test the same vector).
//
// The Edge is the one screen a program holding Fremkit's port cannot write to: with the helper, a
// server that fails /auth/proof never gets the kiosk to load its page. So the code is never sent
// to the extension; the user types it, and the server must prove it knows it before the extension
// proves it back. A server that cannot is not Fremkit, and gets nothing it could guess the code from.

import { base64url, fromBase64url, newNonce, sameBytes } from './proof.js'

export const PAIR_KEY_ITERATIONS = 600_000
export const PAIR_SALT_PREFIX = 'fremkit-companion-pair-code-v1:'
export const PAIR_SERVER_LABEL = 'fremkit-companion-pair-server-v1|'
export const PAIR_CLIENT_LABEL = 'fremkit-companion-pair-client-v1|'

/** The Edge's code: 4 characters of the pairing alphabet (server/src/devices/codes.ts). */
export const CODE_LENGTH = 4
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const utf8 = (s) => new TextEncoder().encode(s)

/** The code as typed, upper-cased and without spaces or dashes; null when it cannot be one. */
export function normalizeCode(typed) {
  const code = String(typed ?? '').toUpperCase().replace(/[\s-]/g, '')
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null
}

/** K(code) for one request: PBKDF2-SHA256, 32 bytes. */
export async function pairKey(code, requestId, iterations = PAIR_KEY_ITERATIONS) {
  const subtle = globalThis.crypto.subtle
  const base = await subtle.importKey('raw', utf8(code), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: utf8(PAIR_SALT_PREFIX + requestId), iterations }, base, 256)
  return new Uint8Array(bits)
}

/** base64url(HMAC-SHA256(key, label + requestId + "|" + nonceE + "|" + nonceS)). */
export async function pairMac(key, label, requestId, nonceE, nonceS) {
  const subtle = globalThis.crypto.subtle
  const hmac = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64url(new Uint8Array(await subtle.sign('HMAC', hmac, utf8(`${label}${requestId}|${nonceE}|${nonceS}`))))
}

const B64_32 = /^[A-Za-z0-9_-]{43}$/

/**
 * One try at the typed `code` for `requestId`. `post(step, body)` sends to
 * `/api/companion/pair/<requestId>/<step>` and resolves the JSON answer, or null.
 *
 * Resolves `{ state: 'paired', token, deviceId }`; `wrong` when the code is not the Edge's (the
 * server's mac did not match it, or the server said so); `exhausted` when that wrong try was the last;
 * `refused` or `expired` as the server says; `failed` for anything else. The client mac, the one
 * value that could let a server grind the code, is sent only after the server's mac matched.
 */
export async function confirmCode({ post, requestId, code, nonce = newNonce() }) {
  const c = await post('confirm', { nonce })
  if (c?.state === 'refused' || c?.state === 'expired') return { state: c.state }
  if (c?.state !== 'confirm' || typeof c.nonce !== 'string' || !B64_32.test(c.nonce) || typeof c.mac !== 'string') return { state: 'failed' }
  const key = await pairKey(code, requestId)
  const expected = await pairMac(key, PAIR_SERVER_LABEL, requestId, nonce, c.nonce)
  if (!sameBytes(fromBase64url(c.mac), fromBase64url(expected))) {
    // Nothing derived from the code goes back: only that this try is over.
    const f = await post('finish', { abandon: true })
    return { state: f?.state === 'refused' ? 'exhausted' : f?.state === 'expired' ? 'expired' : 'wrong' }
  }
  const f = await post('finish', { mac: await pairMac(key, PAIR_CLIENT_LABEL, requestId, nonce, c.nonce) })
  if (f?.state === 'paired' && typeof f.token === 'string' && typeof f.deviceId === 'string') {
    return { state: 'paired', token: f.token, deviceId: f.deviceId }
  }
  if (f?.state === 'wrong') return { state: 'wrong' }
  // The server's mac matched, so the code was right: a refusal now is the Edge's Refuse.
  if (f?.state === 'refused' || f?.state === 'expired') return { state: f.state }
  return { state: 'failed' }
}
