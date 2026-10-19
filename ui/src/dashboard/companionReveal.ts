/**
 * Which page a browser-extension share should bring up on this dashboard.
 *
 * The server stamps each reveal with a `seq`. This dashboard acts on a seq it has not acted on yet:
 * "differs", not "greater", because the counter restarts at 1 when the server does. The first
 * snapshot after (re)subscribing is only recorded, so a reload or a reconnect never jumps pages
 * on its own over a share that was revealed earlier.
 */
export interface CompanionReveal { seq: number; screenId: string; pageIndex: number }

export function createRevealTracker() {
  let primed = false
  let seen: number | null = null
  return {
    /** The page index to select for this snapshot, or null when there is nothing to do. */
    observe(snapshot: { reveal?: CompanionReveal | null }, screenId: string | undefined): number | null {
      const reveal = snapshot.reveal ?? null
      if (!primed) { primed = true; seen = reveal?.seq ?? null; return null }
      if (!reveal) { seen = null; return null }
      if (reveal.seq === seen) return null
      seen = reveal.seq
      return screenId !== undefined && reveal.screenId === screenId ? reveal.pageIndex : null
    },
    /** Forget what was seen: the next snapshot is a fresh baseline. */
    reset() { primed = false; seen = null },
  }
}
