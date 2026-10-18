// A player's site the user allowed from the popup, and when the extension gives that grant back.

import { videoFrameOf } from './video.js'

/**
 * The origin a start must give back, or null. A start that ran on a fresh grant (`grantedOrigin`)
 * keeps it only when it succeeded and a frame of that origin holds a video (`frames`, the cleaned
 * survey the start ran on, null when it never got that far). Every other ending — refused, not
 * paired, no survey, no capture, the server unreachable, a frame with no video — gives it back:
 * the page chose which frame looked like a player, and a grant nobody used stays nobody's.
 */
export function grantToReturn(grantedOrigin, { ok, frames }) {
  if (!grantedOrigin) return null
  if (ok === true && Array.isArray(frames) && videoFrameOf(frames, grantedOrigin)) return null
  return grantedOrigin
}
