// When the extension takes a pairing approval. Pairing carries no secret yet, so whatever answers
// on Fremkit's port is believed; a program holding the port can approve its own code at once. A
// person cannot: the Edge holds Allow back for two seconds after a request shows, then a hand has
// to reach it. An approval sooner than that is not a person's, and is refused.

/** The least time between the request accepted and its approval collected. */
export const MIN_APPROVAL_MS = 2_000

/**
 * True when an approval collected at `now` came too soon after the request was accepted at
 * `acceptedAt` (ms). A missing or odd `acceptedAt` counts as too soon: nothing says when it began.
 */
export function approvalTooFast(acceptedAt, now) {
  if (typeof acceptedAt !== 'number' || !Number.isFinite(acceptedAt)) return true
  return now - acceptedAt < MIN_APPROVAL_MS
}
