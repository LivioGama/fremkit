import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ControlSchema,
  EXTENSION_ORIGIN_RE,
  MAX_MESSAGE_BYTES,
  MAX_SDP,
  MetaSchema,
  PROTOCOL,
  isLocalSdp,
  parseExtensionMessage,
} from '../src/companion/protocol.js'

function sdp(...candidates: string[]): string {
  return ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', ...candidates.map((c) => `a=${c}`), ''].join('\r\n')
}

function host(address: string, type = 'host'): string {
  return `candidate:1 1 udp 2122260223 ${address} 54321 typ ${type} generation 0`
}

const meta = { title: 'A video', host: 'example.com', currentTime: 12.5, duration: 600, paused: false, muted: false, volume: 0.5 }
const token = randomBytes(32).toString('base64url')

describe('constants', () => {
  it('pins the protocol version, the size limits and the extension origin', () => {
    expect(PROTOCOL).toBe(1)
    expect(MAX_MESSAGE_BYTES).toBe(65_536)
    expect(MAX_SDP).toBe(32_000)
    expect(EXTENSION_ORIGIN_RE.test(`chrome-extension://${'a'.repeat(32)}`)).toBe(true)
    expect(EXTENSION_ORIGIN_RE.test(`chrome-extension://${'a'.repeat(31)}q`)).toBe(false)
    expect(EXTENSION_ORIGIN_RE.test(`chrome-extension://${'a'.repeat(32)}/x`)).toBe(false)
    expect(EXTENSION_ORIGIN_RE.test('https://example.com')).toBe(false)
  })
})

describe('isLocalSdp', () => {
  it('accepts host candidates on private, link-local, loopback and .local addresses', () => {
    const addresses = [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.20', '169.254.9.9',
      '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'fe80::1%en0',
      'f3a1c2d4-0000-4000-8000-123456789abc.local',
    ]
    for (const address of addresses) expect(isLocalSdp(sdp(host(address))), address).toBe(true)
  })

  it('accepts an offer with no candidate at all', () => {
    expect(isLocalSdp(sdp())).toBe(true)
  })

  it('refuses srflx, relay and public host candidates', () => {
    expect(isLocalSdp(sdp(host('192.168.1.20', 'srflx')))).toBe(false)
    expect(isLocalSdp(sdp(host('192.168.1.20', 'relay')))).toBe(false)
    const outside = [
      '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '169.253.0.1', '128.0.0.1',
      '2001:db8::1', 'fec0::1', 'fe00::1', 'fe::1', '::', '::ffff:10.0.0.1', 'example.com', 'local',
      '10.0.0', '10.0.0.256', '010.0.0.1',
    ]
    for (const address of outside) expect(isLocalSdp(sdp(host(address))), address).toBe(false)
  })

  it('refuses the whole offer when one candidate is not local', () => {
    expect(isLocalSdp(sdp(host('192.168.1.20'), host('8.8.8.8')))).toBe(false)
  })

  it('refuses a candidate line it cannot read', () => {
    expect(isLocalSdp(sdp('candidate:1 1 udp 2122260223 192.168.1.20'))).toBe(false)
  })

  it('refuses text not starting with v=0 and text over 32000 chars', () => {
    expect(isLocalSdp('')).toBe(false)
    expect(isLocalSdp(' v=0\r\n')).toBe(false)
    expect(isLocalSdp('v=1\r\n')).toBe(false)
    expect(isLocalSdp('v=0\r\n' + 'a=x\r\n'.repeat(MAX_SDP))).toBe(false)
    expect(isLocalSdp('v=0\n' + 'x'.repeat(MAX_SDP - 4))).toBe(true)
    expect(isLocalSdp('v=0\n' + 'x'.repeat(MAX_SDP - 3))).toBe(false)
  })
})

describe('MetaSchema', () => {
  it('accepts a well-formed meta', () => {
    expect(MetaSchema.safeParse(meta).success).toBe(true)
    expect(MetaSchema.safeParse({ ...meta, title: '', host: '192.0.2.7', currentTime: 0, volume: 1 }).success).toBe(true)
  })

  it('refuses a 301-char title, a negative time and a volume of 1.1', () => {
    expect(MetaSchema.safeParse({ ...meta, title: 'x'.repeat(300) }).success).toBe(true)
    expect(MetaSchema.safeParse({ ...meta, title: 'x'.repeat(301) }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, currentTime: -1 }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, duration: 604_801 }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, duration: Infinity }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, currentTime: NaN }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, volume: 1.1 }).success).toBe(false)
    expect(MetaSchema.safeParse({ ...meta, volume: -0.1 }).success).toBe(false)
  })

  it('refuses a host that is not a bare hostname', () => {
    for (const bad of ['', 'https://example.com', 'example.com:8080', 'example.com/path', 'a b.com', '[::1]', 'exa_mple.com', '-a.com', 'a'.repeat(254)]) {
      expect(MetaSchema.safeParse({ ...meta, host: bad }).success, bad).toBe(false)
    }
  })

  it('refuses extra keys and missing fields', () => {
    expect(MetaSchema.safeParse({ ...meta, url: 'https://example.com' }).success).toBe(false)
    const { muted: _muted, ...partial } = meta
    expect(MetaSchema.safeParse(partial).success).toBe(false)
  })
})

describe('ControlSchema', () => {
  it('requires delta for seek and value for volume', () => {
    expect(ControlSchema.safeParse({ action: 'seek' }).success).toBe(false)
    expect(ControlSchema.safeParse({ action: 'seek', delta: 10 }).success).toBe(true)
    expect(ControlSchema.safeParse({ action: 'seek', delta: -10 }).success).toBe(true)
    expect(ControlSchema.safeParse({ action: 'seek', delta: 5 }).success).toBe(false)
    expect(ControlSchema.safeParse({ action: 'volume' }).success).toBe(false)
    expect(ControlSchema.safeParse({ action: 'volume', value: 0.3 }).success).toBe(true)
    expect(ControlSchema.safeParse({ action: 'volume', value: 1.5 }).success).toBe(false)
  })

  it('accepts the plain actions and refuses unknown ones and extra keys', () => {
    for (const action of ['toggle', 'mute', 'stop', 'show']) expect(ControlSchema.safeParse({ action }).success, action).toBe(true)
    expect(ControlSchema.safeParse({ action: 'reload' }).success).toBe(false)
    expect(ControlSchema.safeParse({ action: 'toggle', url: 'x' }).success).toBe(false)
  })
})

describe('parseExtensionMessage', () => {
  const sessionId = randomUUID()
  const receiverId = randomUUID()
  const installId = randomUUID()
  const parse = (m: unknown) => parseExtensionMessage(JSON.stringify(m))

  it('parses each message of the protocol', () => {
    expect(parse({ type: 'hello', token, installId, protocol: PROTOCOL })).not.toBeNull()
    expect(parse({ type: 'hello', token, installId, protocol: PROTOCOL, session: { sessionId, meta } })).not.toBeNull()
    expect(parse({ type: 'tab.started', sessionId, meta })).toMatchObject({ type: 'tab.started', sessionId })
    expect(parse({ type: 'tab.meta', sessionId, meta })).not.toBeNull()
    expect(parse({ type: 'tab.offer', sessionId, receiverId, sdp: sdp(host('192.168.1.20')) })).not.toBeNull()
    expect(parse({ type: 'tab.stopped', sessionId })).toEqual({ type: 'tab.stopped', sessionId })
  })

  it('refuses unknown types, extra keys and oversize input', () => {
    expect(parse({ type: 'tab.unknown', sessionId })).toBeNull()
    expect(parse({ type: 'tab.stopped', sessionId, extra: 1 })).toBeNull()
    expect(parse({ type: 'hello', token, installId, protocol: PROTOCOL, session: { sessionId, meta, extra: 1 } })).toBeNull()
    expect(parse({ type: 'tab.meta', sessionId, meta: { ...meta, url: 'x' } })).toBeNull()
    const padded = JSON.stringify({ type: 'tab.stopped', sessionId, pad: 'x'.repeat(MAX_MESSAGE_BYTES) })
    expect(parseExtensionMessage(padded)).toBeNull()
    // The limit is in bytes: 3-byte characters count three times.
    const wide = JSON.stringify({ type: 'tab.meta', sessionId, meta: { ...meta, title: '€'.repeat(300) } })
    expect(parseExtensionMessage(wide)).not.toBeNull()
    expect(parseExtensionMessage(wide + ' '.repeat(MAX_MESSAGE_BYTES))).toBeNull()
  })

  it('refuses malformed JSON and values that are not objects', () => {
    expect(parseExtensionMessage('{nope')).toBeNull()
    expect(parseExtensionMessage('')).toBeNull()
    expect(parseExtensionMessage('null')).toBeNull()
    expect(parseExtensionMessage('[]')).toBeNull()
  })

  it('refuses bad ids, a malformed token and a non-local offer', () => {
    expect(parse({ type: 'tab.stopped', sessionId: 'not-a-uuid' })).toBeNull()
    expect(parse({ type: 'hello', token: 'short', installId, protocol: PROTOCOL })).toBeNull()
    expect(parse({ type: 'hello', token, installId: 'x', protocol: PROTOCOL })).toBeNull()
    expect(parse({ type: 'hello', token, installId, protocol: 'one' })).toBeNull()
    expect(parse({ type: 'tab.offer', sessionId, receiverId, sdp: sdp(host('8.8.8.8')) })).toBeNull()
    expect(parse({ type: 'tab.offer', sessionId, receiverId: 'x', sdp: sdp() })).toBeNull()
  })

  it('lets a hello carry any protocol number, so the server can answer a version it does not speak', () => {
    expect(parse({ type: 'hello', token, installId, protocol: 2 })).toMatchObject({ protocol: 2 })
  })
})
