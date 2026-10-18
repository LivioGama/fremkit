// What the worker makes of its socket closing. Only the server's word that the record is gone
// unpairs the extension: a refusal it cannot place keeps the token, since a token thrown away
// means walking over to the Mac to pair again.

/** The server's revocation code (`DEVICE_CLOSE_CODE`): no extension record for this token. */
export const REVOKED_CLOSE_CODE = 4401
/** Policy violation: the server could not read what the extension said. */
export const POLICY_CLOSE_CODE = 1008

/**
 * `revoked` (forget the token), `refused` (hello was not understood: the two sides speak
 * different versions, keep the token and say so), or `retry` (a lost connection).
 */
export function closeOutcome(code, greeted) {
  if (code === REVOKED_CLOSE_CODE) return 'revoked'
  if (!greeted && code === POLICY_CLOSE_CODE) return 'refused'
  return 'retry'
}
