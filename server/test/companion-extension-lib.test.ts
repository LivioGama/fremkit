import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
// @ts-expect-error plain JS modules outside server/, no declarations
import { control, cropRect, embeddedPlayer, pickVideo, placeFrame, survey } from '../../companion/lib/video.js'
// @ts-expect-error plain JS module
import { browserName } from '../../companion/lib/browser.js'
// @ts-expect-error plain JS module
import { IDLE_SLACK_MS, idleDelay } from '../../companion/lib/presence.js'
// @ts-expect-error plain JS module
import { closeOutcome, POLICY_CLOSE_CODE, REVOKED_CLOSE_CODE } from '../../companion/lib/link.js'
// @ts-expect-error plain JS module
import { localCandidatesOnly, loopbackAnswer, loopbackForMdns, offerSdp } from '../../companion/lib/sdp.js'
// @ts-expect-error plain JS module
import { expectedMac, newNonce, PROOF_LABEL, sameBytes, verifyProof } from '../../companion/lib/proof.js'
// @ts-expect-error plain JS module
import { handshake, PROOF_TIMEOUT_MS } from '../../companion/lib/handshake.js'
// @ts-expect-error plain JS module
import * as ext from '../../companion/lib/protocol.js'
import { isLocalSdp, parseExtensionMessage, PROOF_LABEL as SERVER_PROOF_LABEL, PROTOCOL } from '../src/companion/protocol.js'
import { HELLO_TIMEOUT_MS } from '../src/companion/socket.js'
import { DEVICE_CLOSE_CODE } from '../src/ws/hub.js'

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
  it('crops only the visible part of a video scrolled partly out of view', () => {
    const left = cropRect({ x: -0.25, y: 0, w: 0.75, h: 0.5 }, 1000, 1000)
    expect(left).toMatchObject({ sx: 0, sw: 500, sy: 0, sh: 500 })
    const right = cropRect({ x: 0.75, y: 0.5, w: 0.5, h: 0.75 }, 1000, 1000)
    expect(right).toMatchObject({ sx: 750, sw: 250, sy: 500, sh: 500 })
  })
  it('refuses an implausible rectangle', () => {
    expect(cropRect({ x: 0.98, y: 0, w: 0.5, h: 0.5 }, 1000, 1000)).toBeNull()
    expect(cropRect({ x: -0.5, y: 0, w: 0.52, h: 0.5 }, 1000, 1000)).toBeNull()
    expect(cropRect({ x: 0, y: 0, w: 0.01, h: 0.5 }, 1000, 1000)).toBeNull()
    expect(cropRect(null, 1000, 1000)).toBeNull()
  })
})

describe('localCandidatesOnly', () => {
  const cand = (addr: string, typ: string, n: number) => `a=candidate:${n} 1 udp 2113937151 ${addr} 5000${n} typ ${typ} generation 0`
  const sdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 'm=video 9 UDP/TLS/RTP/SAVPF 96',
    cand('192.168.1.20', 'host', 1), cand('203.0.113.9', 'srflx', 2), cand('198.51.100.7', 'host', 3),
    cand('abcd-1234.local', 'host', 4), cand('10.0.0.5', 'relay', 5), cand('fe80::1', 'host', 6), cand('2001:db8::1', 'host', 7), ''].join('\r\n')

  it('removes srflx and public candidates', () => {
    expect(isLocalSdp(sdp)).toBe(false)
    const out = localCandidatesOnly(sdp)
    expect(out).toContain('192.168.1.20')
    expect(out).toContain('abcd-1234.local')
    expect(out).toContain('fe80::1')
    expect(out).not.toContain('203.0.113.9')
    expect(out).not.toContain('198.51.100.7')
    expect(out).not.toContain('2001:db8')
    expect(out).not.toContain('relay')
    expect(out).toContain('\r\n')
    expect(isLocalSdp(out)).toBe(true)
  })
})

describe('localCandidatesOnly agrees with the server isLocalSdp', () => {
  const addresses = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.20', '169.254.9.9',
    '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'fe80::1%en0',
    'f3a1c2d4-0000-4000-8000-123456789abc.local',
    '198.51.100.7', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '169.253.0.1', '128.0.0.1',
    '2001:db8::1', 'fec0::1', 'fe00::1', 'fe::1', '::', '::ffff:10.0.0.1', 'example.com', 'local',
    '10.0.0', '10.0.0.256', '010.0.0.1', '10.999.1.1', '10.0.0.1.1', 'fe80:zz', 'fe80::1::2', 'fe80:1:2:3:4:5:6:7:8',
    'fe80:1:2:3:4:5:6:7', 'fe80:1:2:3:4:5:6::', ':fe80::1', 'fe80::1:', 'fe80:::1', 'fe80::12345', 'fd00::1.2.3.4', 'fd00::1.2.3.400',
  ]
  it.each(addresses)('%s', (address) => {
    const line = `a=candidate:1 1 udp 2122260223 ${address} 54321 typ host generation 0`
    const offer = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', line, ''].join('\r\n')
    expect(localCandidatesOnly(offer).includes(line), address).toBe(isLocalSdp(offer))
  })
})

describe('loopbackForMdns', () => {
  // As Chrome writes an offscreen document's offer: its address hidden behind an mDNS name.
  const MDNS = 'a=candidate:680590759 1 udp 2113937151 01d56785-bba5-4960-bb7d-61791c640b67.local 60466 typ host generation 0 network-cost 999'
  const offer = (...lines: string[]) => ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0', ...lines, 'a=mid:0', ''].join('\r\n')

  it('writes an mDNS host candidate on 127.0.0.1 and leaves every other line alone', () => {
    const real = 'a=candidate:2 1 udp 2113937151 192.168.1.20 50001 typ host generation 0'
    const out = loopbackForMdns(offer(MDNS, real))
    expect(out).toBe(offer(
      'a=candidate:680590759 1 udp 2113937151 127.0.0.1 60466 typ host generation 0 network-cost 999', real))
    expect(isLocalSdp(out)).toBe(true)
    expect(loopbackForMdns(out)).toBe(out)
  })

  it('touches only host candidates', () => {
    const srflx = 'a=candidate:3 1 udp 1677729535 abcd.local 50002 typ srflx raddr 0.0.0.0 rport 0'
    expect(loopbackForMdns(offer(srflx))).toBe(offer(srflx))
    const bare = ['v=0', 'a=candidate:4 1 udp 1 abcd.local 50003 typ host'].join('\n')
    expect(loopbackForMdns(bare)).toBe('v=0\na=candidate:4 1 udp 1 127.0.0.1 50003 typ host')
  })

  /**
   * What the offscreen document sends is what the Fremplay widget dials: run through the bridge's
   * `local` wrapper, an mDNS-only offer keeps no candidate, and the rewritten one keeps it. Seen in
   * a real run (Chrome offerer, WKWebView answerer configured like the kiosk): without the rewrite
   * the connection stays `new`, with it it connects.
   */
  it('gives the wrapped receiver a candidate it keeps, where the mDNS name gives it none', async () => {
    const bridge = await readFile(fileURLToPath(new URL('../src/bridge/fremkit.js', import.meta.url)), 'utf8')
    const remote: string[] = []
    class Native {
      setRemoteDescription(d: { sdp: string }) { remote.push(d.sdp); return Promise.resolve() }
    }
    const attrs: Record<string, string> = { 'data-webrtc': 'local', 'data-webrtc-hosts': '127.0.0.1 ::1 192.0.2.10' }
    const window: Record<string, unknown> = { RTCPeerConnection: Native, parent: { postMessage: () => {} }, addEventListener: () => {} }
    const document = {
      currentScript: { getAttribute: (n: string) => attrs[n] ?? null },
      documentElement: { classList: { add: () => {}, remove: () => {} }, style: { setProperty: () => {}, removeProperty: () => {} } },
      head: { firstChild: null, insertBefore: () => {}, appendChild: () => {} },
      createElement: () => ({ setAttribute: () => {}, textContent: '' }),
      querySelector: () => null,
      addEventListener: () => {},
      dispatchEvent: () => {},
    }
    new Function('window', 'document', 'console', bridge)(window, document, console)
    const RTC = window.RTCPeerConnection as new (c: unknown) => { setRemoteDescription(d: unknown): Promise<void> }
    const kept = (sdp: string) => sdp.split('\r\n').filter((l) => l.startsWith('a=candidate'))

    await new RTC({ iceServers: [] }).setRemoteDescription({ type: 'offer', sdp: localCandidatesOnly(offer(MDNS)) })
    expect(kept(remote[0])).toEqual([])
    await new RTC({ iceServers: [] }).setRemoteDescription({ type: 'offer', sdp: offerSdp(offer(MDNS)) })
    expect(kept(remote[1])).toEqual(['a=candidate:680590759 1 udp 2113937151 127.0.0.1 60466 typ host generation 0 network-cost 999'])
  })

})

describe('offerSdp (what the offscreen document sends)', () => {
  const offer = (...lines: string[]) => ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0', ...lines, 'a=mid:0', ''].join('\r\n')
  it('drops what is not local, then writes mDNS names on loopback', () => {
    const mdns = 'a=candidate:1 1 udp 2113937151 0b7d1c2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e.local 60466 typ host generation 0'
    const lan = 'a=candidate:2 1 udp 2113937151 192.168.1.20 50001 typ host generation 0'
    const srflx = 'a=candidate:3 1 udp 1677729535 203.0.113.9 50002 typ srflx raddr 0.0.0.0 rport 0'
    const out = offerSdp(offer(mdns, lan, srflx))
    expect(out).toBe(offer('a=candidate:1 1 udp 2113937151 127.0.0.1 60466 typ host generation 0', lan))
    expect(isLocalSdp(out)).toBe(true)
  })
})

describe('loopbackAnswer (what the offscreen document applies)', () => {
  const answer = (c: string, ...lines: string[]) => ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', c, ...lines, 'a=mid:0', ''].join('\r\n')
  const cand = (address: string, typ = 'host') => `a=candidate:1 1 udp 2122260223 ${address} 54321 typ ${typ} generation 0`

  it.each([
    ['127.0.0.1', true], ['127.1.2.3', true], ['::1', true], ['::1'.toUpperCase(), true],
    ['f3a1c2d4-0000-4000-8000-123456789abc.local', true],
    ['192.168.1.20', false], ['10.0.0.5', false], ['169.254.9.9', false], ['fe80::1', false], ['fd12::1', false],
    ['198.51.100.7', false], ['2001:db8::1', false], ['128.0.0.1', false], ['0.0.0.0', false], ['::', false],
    ['127.0.0', false], ['127.0.0.256', false], ['0127.0.0.1', false], ['.local', false], ['evil.example.com', false],
  ])('candidate %s kept: %s', (address, kept) => {
    const out = loopbackAnswer(answer('c=IN IP4 0.0.0.0', cand(address)))
    expect(out).not.toBeNull()
    expect(out.includes(cand(address))).toBe(kept)
  })

  it('drops every candidate type but host, even on loopback', () => {
    for (const typ of ['srflx', 'prflx', 'relay']) {
      expect(loopbackAnswer(answer('c=IN IP4 0.0.0.0', cand('127.0.0.1', typ)))).toBe(answer('c=IN IP4 0.0.0.0'))
    }
  })

  it.each([
    ['c=IN IP4 0.0.0.0', true], ['c=IN IP4 127.0.0.1', true], ['c=IN IP4 127.9.9.9', true],
    ['c=IN IP6 ::1', true], ['c=IN IP6 ::', true],
    ['c=IN IP4 192.168.1.20', false], ['c=IN IP4 198.51.100.7', false], ['c=IN IP6 2001:db8::1', false],
    ['c=IN IP6 fe80::1', false], ['c=IN IP4 example.com', false], ['c=IN IP4', false], ['c=garbage', false],
  ])('connection line %s accepted: %s', (c, ok) => {
    expect(loopbackAnswer(answer(c, cand('127.0.0.1'))) !== null).toBe(ok)
  })

  it('refuses the answer when any one of several c= lines points elsewhere', () => {
    expect(loopbackAnswer(answer('c=IN IP4 0.0.0.0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 198.51.100.7'))).toBeNull()
  })

  it('keeps every other line and the line endings', () => {
    const sdp = answer('c=IN IP4 0.0.0.0', 'a=ice-ufrag:abcd', cand('127.0.0.1'), cand('192.0.2.10'), 'a=end-of-candidates')
    expect(loopbackAnswer(sdp)).toBe(answer('c=IN IP4 0.0.0.0', 'a=ice-ufrag:abcd', cand('127.0.0.1'), 'a=end-of-candidates'))
    expect(loopbackAnswer(42)).toBeNull()
  })
})

/** Bytes 0..31 as the token, 32..63 as the nonce. The same vector is in companion-socket.test.ts, run through the server's proofMac. */
const PROOF_VECTOR = {
  token: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  nonce: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  mac: 'GBxF4yvVJMBOdFy_XX8CFPUkR962kYga-wTrWEAEOus',
}

describe('the server proof, from the extension side', () => {
  it('signs the label the server signs', () => {
    expect(PROOF_LABEL).toBe(SERVER_PROOF_LABEL)
  })

  it('computes the fixed vector the server test pins', async () => {
    expect(await expectedMac(PROOF_VECTOR.token, PROOF_VECTOR.nonce)).toBe(PROOF_VECTOR.mac)
    expect(await verifyProof(PROOF_VECTOR.token, PROOF_VECTOR.nonce, PROOF_VECTOR.mac)).toBe(true)
  })

  it('refuses a wrong mac, a mac for another nonce or token, and garbage', async () => {
    const { token, nonce, mac } = PROOF_VECTOR
    const flipped = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)
    expect(await verifyProof(token, nonce, flipped)).toBe(false)
    expect(await verifyProof(token, newNonce(), mac)).toBe(false)
    expect(await verifyProof(newNonce(), nonce, mac)).toBe(false)
    for (const bad of ['', mac.slice(1), mac + 'AA', 'not base64!', null, 42]) {
      expect(await verifyProof(token, nonce, bad), String(bad)).toBe(false)
    }
  })

  it('compares bytes without caring where they differ', () => {
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
    expect(sameBytes(null, new Uint8Array([1]))).toBe(false)
  })

  it('makes a fresh 32-byte base64url nonce each time', () => {
    const a = newNonce()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newNonce()).not.toBe(a)
  })
})

describe('handshake (the socket opening)', () => {
  const DEVICE = '0b7d1c2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'
  const { token, nonce, mac } = PROOF_VECTOR

  function run(opts: { timeoutMs?: number } = {}) {
    const sent: string[] = []
    let impostor = 0
    const hs = handshake({
      socket: { send: (s: string) => sent.push(s) },
      deviceId: DEVICE,
      token,
      nonce,
      hello: () => ext.hello(token, ID),
      onImpostor: () => { impostor++ },
      ...opts,
    })
    return { hs, sent, impostors: () => impostor, leaked: () => sent.some((s) => s.includes(token)) }
  }

  it('gives the server as long as the server gives it', () => {
    expect(PROOF_TIMEOUT_MS).toBe(HELLO_TIMEOUT_MS)
  })

  it('sends a challenge the server parses, and no token', () => {
    const t = run()
    t.hs.open()
    expect(t.sent).toHaveLength(1)
    expect(JSON.parse(t.sent[0])).toEqual({ type: 'challenge', deviceId: DEVICE, nonce })
    expect(parseExtensionMessage(t.sent[0])).not.toBeNull()
    expect(t.leaked()).toBe(false)
    t.hs.cancel()
  })

  it('sends hello with the token only after a valid proof', async () => {
    const t = run()
    t.hs.open()
    await t.hs.receive({ type: 'proof', mac })
    expect(t.hs.proven).toBe(true)
    expect(t.sent).toHaveLength(2)
    expect(JSON.parse(t.sent[1])).toMatchObject({ type: 'hello', token, protocol: PROTOCOL })
    expect(t.impostors()).toBe(0)
  })

  it.each([
    ['a wrong mac', { type: 'proof', mac: 'A'.repeat(43) }],
    ['a proof with no mac', { type: 'proof' }],
    ['ready before any proof', { type: 'ready', protocol: PROTOCOL }],
    ['something that is not JSON', null],
  ])('never writes the token after %s, and calls it an impostor', async (_label, msg) => {
    const t = run()
    t.hs.open()
    await t.hs.receive(msg)
    // Even a valid proof after that changes nothing: the socket is done.
    await t.hs.receive({ type: 'proof', mac })
    expect(t.leaked()).toBe(false)
    expect(t.hs.proven).toBe(false)
    expect(t.impostors()).toBe(1)
  })

  it('calls it an impostor when no proof comes in time, and a late one sends nothing', async () => {
    const t = run({ timeoutMs: 20 })
    t.hs.open()
    await new Promise((r) => setTimeout(r, 40))
    expect(t.impostors()).toBe(1)
    await t.hs.receive({ type: 'proof', mac })
    expect(t.leaked()).toBe(false)
  })

  it('a second message while the proof is being checked is an impostor too', async () => {
    const t = run()
    t.hs.open()
    const checking = t.hs.receive({ type: 'proof', mac })
    await t.hs.receive({ type: 'proof', mac })
    await checking
    expect(t.leaked()).toBe(false)
    expect(t.impostors()).toBe(1)
  })

  it('a socket closed before the proof sends nothing and accuses no one', async () => {
    const t = run({ timeoutMs: 20 })
    t.hs.open()
    t.hs.cancel()
    await new Promise((r) => setTimeout(r, 40))
    expect(t.impostors()).toBe(0)
    expect(t.leaked()).toBe(false)
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
      [{ src: 'https://p.example.org/e', getBoundingClientRect: () => box(5, 6, 300, 200) },
        { src: 'https://q.example.org/e', allow: 'autoplay; fullscreen', getBoundingClientRect: () => box(0, 0, 50, 50) },
        { src: 'https://r.example.org/e', allowFullscreen: true, getBoundingClientRect: () => box(0, 0, 60, 60) }])
    const r = survey()
    expect(r).toMatchObject({ href: 'https://example.com/watch', top: true, vw: 1000, vh: 500, title: 'Page', video: { x: 10, y: 20, w: 400, h: 200 } })
    expect(r.iframes).toEqual([
      { src: 'https://p.example.org/e', fs: false, x: 5, y: 6, w: 300, h: 200 },
      { src: 'https://q.example.org/e', fs: true, x: 0, y: 0, w: 50, h: 50 },
      { src: 'https://r.example.org/e', fs: true, x: 0, y: 0, w: 60, h: 60 },
    ])
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

describe('embeddedPlayer', () => {
  const player = (src: string, x: number, w: number, h: number, fs = true) => ({ src, fs, x, y: 0, w, h })
  const page = (iframes: unknown[]) => frame(0, top(null, iframes))

  it('names the largest cross-origin player iframe the survey could not see into', () => {
    const frames = [page([
      player('https://player.example.org/embed/1', 0, 500, 250),
      player('https://big.example.net/embed/2', 0, 800, 400),
      player('https://example.com/same-origin', 0, 900, 450),
    ])]
    expect(embeddedPlayer(frames, null)).toBe('https://big.example.net')
  })

  it('leaves out ads, small frames, frames it already sees and frames smaller than the video found', () => {
    expect(embeddedPlayer([page([player('https://ads.example.net/a', 0, 970, 250, false)])], null)).toBeNull()
    expect(embeddedPlayer([page([player('https://p.example.org/e', 0, 200, 400)])], null)).toBeNull()
    const seen = [page([player('https://p.example.org/e', 0, 800, 400)]),
      frame(4, { href: 'https://p.example.org/e', top: false, vw: 800, vh: 400, title: '', video: null, iframes: [] })]
    expect(embeddedPlayer(seen, null)).toBeNull()
    const picked = { frameId: 0, rect: { x: 0, y: 0, w: 0.9, h: 0.9 } }
    expect(embeddedPlayer([page([player('https://p.example.org/e', 0, 800, 400)])], picked)).toBeNull()
    expect(embeddedPlayer([page([player('about:blank', 0, 800, 400)])], null)).toBeNull()
    expect(embeddedPlayer([], null)).toBeNull()
  })
})

describe('browserName', () => {
  it('names the browser from its brands', () => {
    const brands = (...names: string[]) => names.map((brand) => ({ brand, version: '130' }))
    expect(browserName(brands('Not)A;Brand', 'Chromium', 'Google Chrome'))).toBe('Chrome')
    expect(browserName(brands('Chromium', 'Microsoft Edge', 'Not_A Brand'))).toBe('Edge')
    expect(browserName(brands('Brave', 'Chromium', 'Not.A/Brand'))).toBe('Brave')
    expect(browserName(brands('Chromium', 'Not.A/Brand'))).toBe('Chromium')
    expect(browserName(undefined)).toBe('Chromium')
  })
})

describe('idleDelay', () => {
  it('waits out the whole presence window, not a fixed slack', () => {
    // A stop 5 s into a 30 s window: the check comes after the remaining 25 s.
    expect(idleDelay(30_000, 5_000)).toBe(25_000 + IDLE_SLACK_MS)
  })
  it('checks right away once the window is over', () => {
    expect(idleDelay(1_000, 1_000)).toBe(IDLE_SLACK_MS)
    expect(idleDelay(1_000, 9_000)).toBe(IDLE_SLACK_MS)
  })
})

describe('closeOutcome', () => {
  it('uses the codes the server closes with', () => {
    expect(REVOKED_CLOSE_CODE).toBe(DEVICE_CLOSE_CODE)
    expect(POLICY_CLOSE_CODE).toBe(1008)
  })

  it('forgets the token only on 4401, before or after ready', () => {
    expect(closeOutcome(4401, false)).toBe('revoked')
    expect(closeOutcome(4401, true)).toBe('revoked')
  })

  it('keeps the token when hello is refused with 1008, and says an update is due', () => {
    expect(closeOutcome(1008, false)).toBe('refused')
  })

  it('reconnects after a 1008 once greeted, or any other close', () => {
    expect(closeOutcome(1008, true)).toBe('retry')
    for (const code of [1000, 1001, 1006, 1009, 1011]) {
      expect(closeOutcome(code, false)).toBe('retry')
      expect(closeOutcome(code, true)).toBe('retry')
    }
  })
})
