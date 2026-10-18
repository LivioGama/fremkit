// Frame survey, video placement and crop math for the companion extension. Plain ES module, no
// build step. `survey` and `control` run inside web pages (chrome.scripting.executeScript), so
// each is self-contained: no imports, no reference to anything in this module's scope.

/**
 * Runs in every frame. Reports the frame's largest visible video (in that frame's px) and, in the
 * top frame, where each iframe sits, so a player embedded from another origin can be located.
 * SELF-CONTAINED: it is serialised into the page.
 */
export function survey() {
  const visible = (v) => {
    const r = v.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  }
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }
  const v = [...document.querySelectorAll('video')]
    .filter(visible)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
  const isTop = window === window.top
  return {
    href: location.href,
    top: isTop,
    vw: innerWidth,
    vh: innerHeight,
    title: document.title,
    video: v ? box(v) : null,
    iframes: isTop
      ? [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src, ...box(f) })).filter((f) => f.w > 0 && f.h > 0)
      : [],
  }
}

/**
 * Runs in the chosen frame: applies an action to its main video and reports the state. Actions
 * are `toggle`, `seek` ({ delta: ±10 }), `volume` ({ value: 0..1 }) and `mute` (a toggle); `show`
 * and `stop` are the extension's business, not the page's. Null when the frame has no video.
 * SELF-CONTAINED: it is serialised into the page.
 */
export function control(action, args) {
  const v = [...document.querySelectorAll('video')].sort(
    (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
  )[0]
  if (!v) return null
  // YouTube puts its own volume back over the element's: go through its player when there is one.
  const yt = document.getElementById('movie_player')
  const ytVolume = yt && typeof yt.setVolume === 'function'
  const duration = Number.isFinite(v.duration) ? v.duration : 0
  const opts = args || {}
  if (action === 'toggle') {
    if (v.paused) v.play()
    else v.pause()
  } else if (action === 'seek') {
    const delta = Number(opts.delta) || 0
    v.currentTime = Math.max(0, Math.min(duration || v.currentTime + delta, v.currentTime + delta))
  } else if (action === 'volume') {
    const value = Math.max(0, Math.min(1, Number(opts.value) || 0))
    if (ytVolume) {
      yt.setVolume(Math.round(value * 100))
      if (value > 0) yt.unMute()
    } else {
      v.volume = value
      if (value > 0) v.muted = false
    }
  } else if (action === 'mute') {
    if (ytVolume) {
      if (yt.isMuted()) yt.unMute()
      else yt.mute()
    } else v.muted = !v.muted
  }
  return {
    paused: v.paused,
    currentTime: v.currentTime,
    duration,
    volume: ytVolume ? yt.getVolume() / 100 : v.volume,
    muted: ytVolume ? yt.isMuted() : v.muted,
  }
}

function originOf(url) {
  try {
    const { origin } = new URL(url)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/** Where an iframe's document sits in the top page: same URL, else same origin (largest), else null. */
export function placeFrame(frame, iframes) {
  const exact = iframes.find((f) => f.src === frame.href)
  if (exact) return exact
  const origin = originOf(frame.href)
  if (!origin) return null
  return iframes.filter((f) => originOf(f.src) === origin).sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null
}

/**
 * The biggest video of a tab, from the `executeScript` results of `survey` over all frames
 * (`{ frameId, result }`). The rectangle is a fraction of the top viewport. A frame that cannot be
 * placed in the top page is skipped rather than guessed.
 */
export function pickVideo(frames) {
  const topResult = frames.find((f) => f.result?.top)?.result
  if (!topResult) return null
  let best = null
  for (const f of frames) {
    const r = f.result
    if (!r?.video) continue
    let rect
    if (r.top) rect = r.video
    else {
      const at = placeFrame(r, topResult.iframes ?? [])
      if (!at) continue
      const sx = at.w / r.vw
      const sy = at.h / r.vh
      rect = { x: at.x + r.video.x * sx, y: at.y + r.video.y * sy, w: r.video.w * sx, h: r.video.h * sy }
    }
    if (!best || rect.w * rect.h > best.rect.w * best.rect.h) best = { frameId: f.frameId, rect }
  }
  if (!best) return null
  const { x, y, w, h } = best.rect
  return { frameId: best.frameId, rect: { x: x / topResult.vw, y: y / topResult.vh, w: w / topResult.vw, h: h / topResult.vh } }
}

/**
 * The source rectangle (in captured-frame px) and the even output size for a video rectangle given
 * as fractions of the viewport. Null for no rectangle or an implausible one: video only, never the
 * whole tab, so the caller keeps its last frame instead.
 */
export function cropRect(rect, videoWidth, videoHeight, max = { w: 1920, h: 1080 }) {
  if (!rect || !videoWidth || !videoHeight || rect.w < 0.05 || rect.h < 0.05) return null
  const sx = Math.max(0, videoWidth * rect.x)
  const sy = Math.max(0, videoHeight * rect.y)
  const sw = Math.min(videoWidth - sx, videoWidth * rect.w)
  const sh = Math.min(videoHeight - sy, videoHeight * rect.h)
  if (sw <= 0 || sh <= 0) return null
  const scale = Math.min(1, max.w / sw, max.h / sh)
  // Even sizes: the H.264 encoder behind WebRTC wants them.
  const w = Math.round(sw * scale) & ~1
  const h = Math.round(sh * scale) & ~1
  if (w < 2 || h < 2) return null
  return { sx, sy, sw, sh, w, h }
}
