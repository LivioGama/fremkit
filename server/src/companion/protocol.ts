import { isIP } from 'node:net'
import { z } from 'zod'
import { isWellFormedToken } from '../http/access.js'

export const PROTOCOL = 1

/** The origin of a Chrome extension: its id is 32 letters from a to p. */
export const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/

export const MAX_MESSAGE_BYTES = 65_536
export const MAX_SDP = 32_000

const MAX_TITLE = 300
/** A week: longer than any video, short enough to keep a bogus value off the screen. */
const MAX_SECONDS = 604_800

function isLocalAddress(address: string): boolean {
  // mDNS names are what browsers put in a host candidate to hide the real address.
  if (address.endsWith('.local') && address.length > '.local'.length) return /^[a-z0-9.-]+$/i.test(address)
  // A link-local IPv6 address may name its interface: fe80::1%en0.
  const family = isIP(address.split('%')[0])
  if (family === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (family === 6) {
    const bare = address.split('%')[0].toLowerCase()
    if (bare === '::1') return true
    // Only the leading group matters for the two prefixes; `::` forms have an empty one.
    const first = bare.split(':')[0]
    if (first === '' || first.length !== 4) return false
    const value = parseInt(first, 16)
    return (value >= 0xfe80 && value <= 0xfebf) || (value >= 0xfc00 && value <= 0xfdff)
  }
  return false
}

/**
 * True when an offer reveals nothing beyond the local network: it starts with `v=0`, fits
 * `MAX_SDP`, and every candidate is of type `host` on a loopback, private, link-local or `.local`
 * address. The offer is the only thing that tells the iPad or the Mac where to connect, so a
 * server-reflexive or relay candidate (or a public address) is refused rather than relayed.
 */
export function isLocalSdp(sdp: string): boolean {
  if (sdp.length > MAX_SDP || !sdp.startsWith('v=0')) return false
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue
    // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
    const fields = line.split(/\s+/)
    if (fields[6] !== 'typ' || fields[7] !== 'host' || !isLocalAddress(fields[4] ?? '')) return false
  }
  return true
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

/**
 * A bare hostname, as `new URL(...).hostname` gives it: no scheme, port or path. IPv6 hostnames
 * (which the URL API wraps in brackets) are refused: a video page on a bare IPv6 address is not
 * worth the extra grammar.
 */
const HostSchema = z.string().regex(HOSTNAME_RE)

const SecondsSchema = z.number().min(0).max(MAX_SECONDS)

export const MetaSchema = z.strictObject({
  title: z.string().max(MAX_TITLE),
  host: HostSchema,
  currentTime: SecondsSchema,
  duration: SecondsSchema,
  paused: z.boolean(),
  muted: z.boolean(),
  volume: z.number().min(0).max(1),
})
export type TabMeta = z.infer<typeof MetaSchema>

const Id = z.uuid()
const Sdp = z.string().max(MAX_SDP).refine(isLocalSdp, 'not a local offer')
const Token = z.string().refine(isWellFormedToken, 'not a token')

export const ExtensionMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('hello'),
    token: Token,
    installId: Id,
    // Any integer: the server answers a version it does not speak with `tab.refused`.
    protocol: z.number().int(),
    session: z.strictObject({ sessionId: Id, meta: MetaSchema }).optional(),
  }),
  z.strictObject({ type: z.literal('tab.started'), sessionId: Id, meta: MetaSchema }),
  z.strictObject({ type: z.literal('tab.meta'), sessionId: Id, meta: MetaSchema }),
  z.strictObject({ type: z.literal('tab.offer'), sessionId: Id, receiverId: Id, sdp: Sdp }),
  z.strictObject({ type: z.literal('tab.stopped'), sessionId: Id }),
])
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>

export const ControlSchema = z
  .strictObject({
    action: z.enum(['toggle', 'seek', 'volume', 'mute', 'stop', 'show']),
    delta: z.union([z.literal(-10), z.literal(10)]).optional(),
    value: z.number().min(0).max(1).optional(),
  })
  .refine((c) => c.action !== 'seek' || c.delta !== undefined, { message: 'seek needs a delta' })
  .refine((c) => c.action !== 'volume' || c.value !== undefined, { message: 'volume needs a value' })
export type Control = z.infer<typeof ControlSchema>

/** What the server sends the extension. It is built here, never parsed, so it is a plain type. */
export type ServerMessage =
  | { type: 'ready'; protocol: number }
  | { type: 'tab.accepted'; sessionId: string }
  | { type: 'tab.refused'; sessionId: string; reason: 'noWidget' | 'protocol' }
  | { type: 'tab.view'; receiverId: string }
  | { type: 'tab.answer'; receiverId: string; sdp: string }
  | ({ type: 'tab.control' } & Control)
  | { type: 'tab.detach'; receiverId: string }
  | { type: 'tab.stop' }
  | { type: 'revoked' }

/** Null when the text is over the size limit, is not JSON, or is not one of the messages. */
export function parseExtensionMessage(raw: string): ExtensionMessage | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = ExtensionMessageSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}
