/**
 * Fremplay's decisions, kept out of index.html so they can be unit tested on their own: which
 * state a `companion` snapshot puts on screen, and what this frame's receiver does next. The page
 * owns the WebRTC peer and the timers; everything it decides with is here. A plain script, loaded
 * with a <script> tag in the widget and evaluated against a scope object in the test.
 */
;(function (root) {
  'use strict'

  /** The companion protocol this widget speaks. */
  var PROTOCOL = 1

  /**
   * One of 'unpaired', 'offline', 'idle', 'sharing' or 'protocol' (the server speaks another
   * protocol than this widget); null before the first snapshot.
   *
   * A share wins over the extension's socket: one that dropped (a server restart) comes back with
   * its share, and the video keeps flowing peer to peer meanwhile.
   */
  function stateOf(snap) {
    if (!snap || typeof snap !== 'object') return null
    if (snap.protocol !== PROTOCOL) return 'protocol'
    var tab = snap.tab || {}
    if (tab.state === 'sharing' && tab.sessionId) return 'sharing'
    var ext = snap.extensions || {}
    if (!(ext.paired > 0)) return 'unpaired'
    if (!(ext.connected > 0)) return 'offline'
    return 'idle'
  }

  /**
   * What the receiver does on a snapshot, given what it holds:
   * `{ receiverId, sessionId, viewed, live, lastOffer, hidden }`.
   *
   * - `reset`: the share this frame was on is over or replaced; drop the peer and start over.
   * - `answer`: the offer to answer — this receiver's, and not the one it answered last.
   * - `view`: ask the extension for an offer — sharing, visible, nothing pending and no live peer.
   *
   * An offer stays in the snapshot after it was answered, so `lastOffer` is kept across a dead
   * peer and only forgotten with the share: a peer that died is replaced by viewing again, never
   * by answering its stale offer a second time.
   */
  function plan(snap, local) {
    var out = { reset: false, view: false, answer: null }
    var sharing = stateOf(snap) === 'sharing'
    var sessionId = sharing ? snap.tab.sessionId : null
    var reset = sessionId !== local.sessionId
    out.reset = reset
    if (!sharing || local.hidden) return out
    var offers = snap.tab.offers || {}
    var offer = Object.prototype.hasOwnProperty.call(offers, local.receiverId) ? offers[local.receiverId] : null
    var lastOffer = reset ? null : local.lastOffer
    if (typeof offer === 'string' && offer !== lastOffer) out.answer = offer
    else if (reset || (!local.viewed && !local.live)) out.view = true
    return out
  }

  /** A position in seconds as m:ss, or h:mm:ss from an hour on. */
  function clock(seconds) {
    var total = typeof seconds === 'number' && isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
    var h = Math.floor(total / 3600)
    var m = Math.floor((total % 3600) / 60)
    var s = total % 60
    var ss = (s < 10 ? '0' : '') + s
    if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + ss
    return m + ':' + ss
  }

  /** The volume one step away, inside 0..1 and rounded to a tenth. An unknown one counts as full. */
  function stepVolume(volume, step) {
    var v = typeof volume === 'number' && isFinite(volume) ? volume : 1
    return Math.min(1, Math.max(0, Math.round((v + step) * 10) / 10))
  }

  root.FremkitFremplay = { PROTOCOL: PROTOCOL, stateOf: stateOf, plan: plan, clock: clock, stepVolume: stepVolume }
})(typeof globalThis !== 'undefined' ? globalThis : this)
