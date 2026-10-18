import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS modules outside server/, no declarations
import { control, cropRect, pickVideo, placeFrame, survey } from '../../companion/lib/video.js'
// @ts-expect-error plain JS module
import { localCandidatesOnly } from '../../companion/lib/sdp.js'
// @ts-expect-error plain JS module
import * as ext from '../../companion/lib/protocol.js'
import { isLocalSdp, parseExtensionMessage, PROTOCOL } from '../src/companion/protocol.js'

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b'
const RID = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const TOKEN = 'A'.repeat(43)

type Rect = { x: number; y: number; w: number; h: number }
const frame = (frameId: number, result: unknown) => ({ frameId, result })
const top = (video: Rect | null, iframes: unknown[] = []) => ({
  href: 'https://example.com/watch', top: true, vw: 1000, vh: 500, title: 'T', video, iframes,
})

describe('pickVideo', () => {
  it('prefers the largest video across frames in top coordinates', () => {
    const frames = [
      frame(0, top({ x: 0, y: 0, w: 200, h: 100 }, [{ src: 'https://player.example.org/embed/1', x: 100, y: 50, w: 800, h: 400 }])),
      // The embedded player is 400x200 in its own viewport, shown at 800x400: scale 2.
      frame(7, { href: 'https://player.example.org/embed/1', top: false, vw: 400, vh: 200, title: '', video: { x: 0, y: 0, w: 400, h: 200 }, iframes: [] }),
    ]
    expect(pickVideo(frames)).toEqual({ frameId: 7, rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } })
  })

  it('returns null when no frame has a visible video', () => {
    expect(pickVideo([frame(0, top(null))])).toBeNull()
    expect(pickVideo([])).toBeNull()
    expect(pickVideo([frame(0, null)])).toBeNull()
    // A video in a frame that cannot be placed is skipped, not guessed.
    expect(pickVideo([frame(0, top(null)), frame(3, { href: 'https://other.example/', top: false, vw: 10, vh: 10, title: '', video: { x: 0, y: 0, w: 10, h: 10 }, iframes: [] })])).toBeNull()
  })
})

describe('placeFrame', () => {
  const iframes = [
    { src: 'https://player.example.org/a', x: 0, y: 0, w: 100, h: 100 },
    { src: 'https://player.example.org/b', x: 0, y: 0, w: 300, h: 300 },
    { src: 'https://elsewhere.example.net/c', x: 0, y: 0, w: 900, h: 900 },
  ]
  it('matches by URL then by origin, else null', () => {
    expect(placeFrame({ href: 'https://player.example.org/a' }, iframes)).toBe(iframes[0])
    expect(placeFrame({ href: 'https://player.example.org/zzz' }, iframes)).toBe(iframes[1])
    expect(placeFrame({ href: 'https://nope.example.com/' }, iframes)).toBeNull()
    expect(placeFrame({ href: 'about:blank' }, iframes)).toBeNull()
  })
})

describe('cropRect', () => {
  it('keeps even dimensions within 1920x1080', () => {
    const c = cropRect({ x: 0, y: 0, w: 1, h: 1 }, 3840, 2160)
    expect(c.w).toBeLessThanOrEqual(1920)
    expect(c.h).toBeLessThanOrEqual(1080)
    expect(c.w % 2).toBe(0)
    expect(c.h % 2).toBe(0)
    expect(c).toMatchObject({ sx: 0, sy: 0, sw: 3840, sh: 2160, w: 1920, h: 1080 })
    const odd = cropRect({ x: 0.1, y: 0.1, w: 0.333, h: 0.333 }, 1001, 777)
    expect(odd.w % 2).toBe(0)
    expect(odd.h % 2).toBe(0)
  })
  it('clamps to the frame and refuses an implausible rectangle', () => {
    const c = cropRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 1000, 1000)
    expect(c.sx + c.sw).toBeLessThanOrEqual(1000)
    expect(c.sy + c.sh).toBeLessThanOrEqual(1000)
    expect(cropRect({ x: 0, y: 0, w: 0.01, h: 0.5 }, 1000, 1000)).toBeNull()
    expect(cropRect(null, 1000, 1000)).toBeNull()
  })
})

describe('localCandidatesOnly', () => {
  const cand = (addr: string, typ: string, n: number) => `a=candidate:${n} 1 udp 2113937151 ${addr} 5000${n} typ ${typ} generation 0`
  const sdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 'm=video 9 UDP/TLS/RTP/SAVPF 96',
    cand('192.168.1.20', 'host', 1), cand('203.0.113.9', 'srflx', 2), cand('8.8.8.8', 'host', 3),
    cand('abcd-1234.local', 'host', 4), cand('10.0.0.5', 'relay', 5), cand('fe80::1', 'host', 6), cand('2001:db8::1', 'host', 7), ''].join('\r\n')

  it('removes srflx and public candidates', () => {
    expect(isLocalSdp(sdp)).toBe(false)
    const out = localCandidatesOnly(sdp)
    expect(out).toContain('192.168.1.20')
    expect(out).toContain('abcd-1234.local')
    expect(out).toContain('fe80::1')
    expect(out).not.toContain('203.0.113.9')
    expect(out).not.toContain('8.8.8.8')
    expect(out).not.toContain('2001:db8')
    expect(out).not.toContain('relay')
    expect(out).toContain('\r\n')
    expect(isLocalSdp(out)).toBe(true)
  })
})

describe('protocol builders', () => {
  const meta = { title: 'x'.repeat(400), host: 'example.com', currentTime: 3, duration: Infinity, paused: false, muted: false, volume: 0.5 }
  it('produce messages the server parseExtensionMessage accepts', () => {
    expect(ext.PROTOCOL).toBe(PROTOCOL)
    const sdp = 'v=0\r\na=candidate:1 1 udp 1 192.168.1.4 50000 typ host\r\n'
    const msgs = [
      ext.hello(TOKEN, ID),
      ext.hello(TOKEN, ID, { sessionId: RID, meta }),
      ext.started(ID, meta),
      ext.meta(ID, meta),
      ext.offer(ID, RID, sdp),
      ext.stopped(ID),
    ]
    for (const m of msgs) expect(parseExtensionMessage(JSON.stringify(m)), JSON.stringify(m).slice(0, 80)).not.toBeNull()
  })
  it('clamps odd page values into a valid meta', () => {
    const m = ext.cleanMeta({ ...meta, currentTime: NaN, volume: 7, host: 'EXAMPLE.com' })
    expect(m.title).toHaveLength(300)
    expect(m.duration).toBe(0)
    expect(m.currentTime).toBe(0)
    expect(m.volume).toBe(1)
    expect(ext.cleanMeta({ ...meta, duration: 1e9 }).duration).toBe(604800)
  })
  it('derives a host from a URL', () => {
    expect(ext.hostOf('https://www.example.com:8080/a?b')).toBe('www.example.com')
    expect(ext.hostOf('garbage')).toBe('unknown')
  })
})

// Minimal fakes: survey and control only touch these members.
const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h, top: y, left: x, bottom: y + h, right: x + w })
function fakeVideo(w: number, h: number, extra: Record<string, unknown> = {}) {
  const el: any = { clientWidth: w, clientHeight: h, paused: true, currentTime: 50, duration: 100, volume: 0.5, muted: false,
    getBoundingClientRect: () => box(10, 20, w, h), play() { el.paused = false }, pause() { el.paused = true }, ...extra }
  return el
}
function install(videos: any[], iframes: any[] = [], movie: any = null, isTop = true) {
  const g = globalThis as any
  const win: any = { innerWidth: 1000, innerHeight: 500 }
  win.top = isTop ? win : {}
  g.window = win
  g.innerWidth = 1000
  g.innerHeight = 500
  g.location = { href: 'https://example.com/watch' }
  g.document = {
    title: 'Page',
    querySelectorAll: (s: string) => (s === 'video' ? videos : s === 'iframe' ? iframes : []),
    getElementById: (id: string) => (id === 'movie_player' ? movie : null),
  }
}

describe('survey (in-page)', () => {
  it('reports the largest visible video and the iframes of the top frame', () => {
    install([fakeVideo(100, 50), fakeVideo(400, 200), fakeVideo(0, 0, { getBoundingClientRect: () => box(0, 0, 0, 0) })],
      [{ src: 'https://p.example.org/e', getBoundingClientRect: () => box(5, 6, 300, 200) }])
    const r = survey()
    expect(r).toMatchObject({ href: 'https://example.com/watch', top: true, vw: 1000, vh: 500, title: 'Page', video: { x: 10, y: 20, w: 400, h: 200 } })
    expect(r.iframes).toEqual([{ src: 'https://p.example.org/e', x: 5, y: 6, w: 300, h: 200 }])
  })
  it('gives no iframes from a child frame and null without a video', () => {
    install([], [{ src: 'https://p.example.org/e', getBoundingClientRect: () => box(5, 6, 300, 200) }], null, false)
    const r = survey()
    expect(r.video).toBeNull()
    expect(r.top).toBe(false)
    expect(r.iframes).toEqual([])
  })
})

describe('control (in-page)', () => {
  it('toggles, seeks within bounds, sets volume and mutes the element', () => {
    const v = fakeVideo(400, 200)
    install([fakeVideo(10, 10), v])
    expect(control('toggle')).toMatchObject({ paused: false })
    expect(control('seek', { delta: 10 })).toMatchObject({ currentTime: 60 })
    v.currentTime = 95
    expect(control('seek', { delta: 10 }).currentTime).toBe(100)
    v.currentTime = 4
    expect(control('seek', { delta: -10 }).currentTime).toBe(0)
    expect(control('volume', { value: 0.25 })).toMatchObject({ volume: 0.25, muted: false })
    expect(control('mute')).toMatchObject({ muted: true })
    expect(control('mute')).toMatchObject({ muted: false })
    expect(control(null)).toMatchObject({ paused: false, duration: 100 })
  })
  it('goes through the YouTube player when it is there', () => {
    let vol = 40, muted = false
    const yt = { getVolume: () => vol, setVolume: (n: number) => { vol = n }, isMuted: () => muted, mute: () => { muted = true }, unMute: () => { muted = false } }
    install([fakeVideo(400, 200)], [], yt)
    expect(control('volume', { value: 0.8 })).toMatchObject({ volume: 0.8, muted: false })
    expect(vol).toBe(80)
    expect(control('mute')).toMatchObject({ muted: true })
    expect(control('mute')).toMatchObject({ muted: false })
  })
  it('returns null with no video and a finite duration for a live stream', () => {
    install([])
    expect(control('toggle')).toBeNull()
    install([fakeVideo(10, 10, { duration: Infinity })])
    expect(control(null)!.duration).toBe(0)
  })
})
