import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import WebSocket from 'ws'
import { DeviceStore } from '../src/devices/store.js'
import { CompanionSession } from '../src/companion/session.js'
import { CompanionSockets, HELLO_TIMEOUT_MS, companionSocket } from '../src/companion/socket.js'
import { MAX_WS_PAYLOAD_BYTES } from '../src/ws/hub.js'
import { buildApp } from '../src/app.js'
import { CONFIG_VERSION } from '../src/config/schema.js'
import { noAdvertise } from '../src/devices/bonjour.js'
import { generateToken } from '../src/http/access.js'
import { execFileAsync, type Exec } from '../src/secrets/keychain.js'
import { hasOpenssl, upgrade } from './helpers/remote.js'

const ORIGIN = `chrome-extension://${'c'.repeat(32)}`
const OTHER = `chrome-extension://${'d'.repeat(32)}`
const INSTALL = '0b7d1c2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'
const INSTALL_2 = '1c8e2d3f-5a6b-4c7d-9e8f-0a1b2c3d4e5f'
const S1 = '11111111-1111-4111-8111-111111111111'
const META = { title: 'A video', host: 'video.example.com', currentTime: 1, duration: 60, paused: false, muted: false, volume: 1 }

let dir: string
let app: FastifyInstance
let store: DeviceStore
let session: CompanionSession
let port: number

interface Client {
  ws: WebSocket
  messages: unknown[]
  next: () => Promise<unknown>
  closed: Promise<{ code: number }>
  send: (msg: unknown) => void
}

function connect(origin: string | null = ORIGIN): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/companion/ws`, origin === null ? {} : { origin })
    const messages: unknown[] = []
    const waiting: Array<(m: unknown) => void> = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      const waiter = waiting.shift()
      if (waiter) waiter(msg)
      else messages.push(msg)
    })
    const closed = new Promise<{ code: number }>((res) => ws.on('close', (code) => res({ code })))
    ws.on('error', () => undefined)
    ws.once('open', () => resolve({
      ws,
      messages,
      closed,
      next: () => messages.length > 0 ? Promise.resolve(messages.shift()) : new Promise((res) => waiting.push(res)),
      send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    }))
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)))
  })
}

async function paired(origin = ORIGIN, installId = INSTALL) {
  return store.createExtension({ name: 'Chrome', origin, installId })
}

/** A connected extension that said hello and got `ready`. */
async function hello(token: string, installId = INSTALL, origin = ORIGIN): Promise<Client> {
  const client = await connect(origin)
  client.send({ type: 'hello', token, installId, protocol: 1 })
  expect(await client.next()).toEqual({ type: 'ready', protocol: 1 })
  return client
}

describe('companion socket', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-companion-socket-'))
    store = new DeviceStore(join(dir, 'devices.json'))
    await store.load()
    const sockets = new CompanionSockets()
    session = new CompanionSession({
      send: (id, msg) => sockets.send(id, msg),
      changed: () => undefined,
      canShare: () => true,
      pairedCount: () => store.list().filter((d) => d.kind === 'extension').length,
    })
    app = Fastify()
    await app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } })
    await app.register(companionSocket, { store, session, sockets, helloTimeoutMs: 200 })
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as { port: number }).port
  })
  afterEach(async () => {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('waits 5 s for hello by default', () => {
    expect(HELLO_TIMEOUT_MS).toBe(5_000)
  })

  it('no hello within 5 s closes 1008', async () => {
    const client = await connect()
    expect(await client.closed).toEqual({ code: 1008 })
  })

  it('a page that is not an extension closes 1008', async () => {
    const { token } = await paired()
    for (const origin of [null, 'http://127.0.0.1:4242', 'https://example.com', `chrome-extension://${'q'.repeat(32)}`]) {
      const client = await connect(origin)
      client.send({ type: 'hello', token, installId: INSTALL, protocol: 1 })
      expect(await client.closed).toEqual({ code: 1008 })
    }
  })

  it('a wrong token closes 1008', async () => {
    await paired()
    const unknown = await connect()
    unknown.send({ type: 'hello', token: randomBytes(32).toString('base64url'), installId: INSTALL, protocol: 1 })
    expect(await unknown.closed).toEqual({ code: 1008 })
    const malformed = await connect()
    malformed.send({ type: 'hello', token: 'short', installId: INSTALL, protocol: 1 })
    expect(await malformed.closed).toEqual({ code: 1008 })
  })

  it('a token from another origin or installId closes 1008', async () => {
    const { token } = await paired()
    const elsewhere = await connect(OTHER)
    elsewhere.send({ type: 'hello', token, installId: INSTALL, protocol: 1 })
    expect(await elsewhere.closed).toEqual({ code: 1008 })
    const otherInstall = await connect()
    otherInstall.send({ type: 'hello', token, installId: INSTALL_2, protocol: 1 })
    expect(await otherInstall.closed).toEqual({ code: 1008 })
  })

  it('an iPad token closes 1008', async () => {
    const { token } = await store.create('iPad', { width: 1180, height: 820 }, null)
    const client = await connect()
    client.send({ type: 'hello', token, installId: INSTALL, protocol: 1 })
    expect(await client.closed).toEqual({ code: 1008 })
  })

  it('a first message other than hello closes 1008', async () => {
    const client = await connect()
    client.send({ type: 'tab.stopped', sessionId: S1 })
    expect(await client.closed).toEqual({ code: 1008 })
  })

  it('hello is answered ready and marks the device seen', async () => {
    const { token, device } = await paired()
    await hello(token)
    await expect.poll(() => store.list().find((d) => d.id === device.id)?.lastSeen).not.toBeNull()
    expect(session.snapshot().extensions).toEqual({ connected: 1, paired: 1 })
  })

  it('anything after hello that is not a message, or a second hello, closes 1008', async () => {
    const { token } = await paired()
    const garbled = await hello(token)
    garbled.send('not json')
    expect(await garbled.closed).toEqual({ code: 1008 })
    const unknown = await hello(token)
    unknown.send({ type: 'tab.nonsense' })
    expect(await unknown.closed).toEqual({ code: 1008 })
    const twice = await hello(token)
    twice.send({ type: 'hello', token, installId: INSTALL, protocol: 1 })
    expect(await twice.closed).toEqual({ code: 1008 })
    await expect.poll(() => session.snapshot().extensions.connected).toBe(0)
  })

  it('an oversize message closes the socket before anything reads it', async () => {
    const { token } = await paired()
    const client = await hello(token)
    client.send({ type: 'tab.meta', sessionId: S1, meta: { ...META, title: 'x'.repeat(MAX_WS_PAYLOAD_BYTES) } })
    // `ws` enforces the cap itself, with the standard "message too big" code, before the route
    // could answer 1008: nothing of the message is buffered past 64 KiB.
    expect(await client.closed).toEqual({ code: 1009 })
  })

  it('carries a share: started is accepted, and the session hears its meta', async () => {
    const { token } = await paired()
    const client = await hello(token)
    client.send({ type: 'tab.started', sessionId: S1, meta: META })
    expect(await client.next()).toEqual({ type: 'tab.accepted', sessionId: S1 })
    expect(session.snapshot().tab).toMatchObject({ state: 'sharing', sessionId: S1, device: 'Chrome' })
    expect(session.control({ action: 'toggle' })).toBe(true)
    expect(await client.next()).toEqual({ type: 'tab.control', action: 'toggle' })
  })

  it('a second socket for the same record replaces the first', async () => {
    const { token } = await paired()
    const first = await hello(token)
    const second = await hello(token)
    expect((await first.closed).code).toBe(1000)
    expect(session.snapshot().extensions.connected).toBe(1)
    second.send({ type: 'tab.started', sessionId: S1, meta: META })
    expect(await second.next()).toEqual({ type: 'tab.accepted', sessionId: S1 })
  })

  it('revoking the device sends revoked and closes 4401', async () => {
    const { token, device } = await paired()
    const client = await hello(token)
    await store.remove(device.id)
    expect(await client.next()).toEqual({ type: 'revoked' })
    expect(await client.closed).toEqual({ code: 4401 })
    expect(session.snapshot().extensions.connected).toBe(0)
  })

  it('revoking one extension leaves another\'s share running', async () => {
    const a = await paired(ORIGIN, INSTALL)
    const b = await paired(ORIGIN, INSTALL_2)
    const sharing = await hello(a.token, INSTALL)
    const other = await hello(b.token, INSTALL_2)
    sharing.send({ type: 'tab.started', sessionId: S1, meta: META })
    expect(await sharing.next()).toEqual({ type: 'tab.accepted', sessionId: S1 })
    await store.remove(b.device.id)
    expect(await other.closed).toEqual({ code: 4401 })
    expect(session.snapshot()).toMatchObject({ extensions: { connected: 1, paired: 1 }, tab: { state: 'sharing', sessionId: S1 } })
    expect(sharing.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('revoking the sharing extension ends its share', async () => {
    const { token, device } = await paired()
    const client = await hello(token)
    client.send({ type: 'tab.started', sessionId: S1, meta: META })
    expect(await client.next()).toEqual({ type: 'tab.accepted', sessionId: S1 })
    await store.remove(device.id)
    expect(await client.closed).toEqual({ code: 4401 })
    expect(session.snapshot().tab.state).toBe('idle')
  })
})

describe('companion socket in the app', () => {
  const SECRET = generateToken()
  const HOST = '127.0.0.1:4242'
  const exec: Exec = (cmd, args) =>
    cmd === 'scutil' ? Promise.resolve({ stdout: 'example\n' }) : execFileAsync(cmd, args)
  let appDir: string
  let full: FastifyInstance

  beforeEach(async () => {
    appDir = await mkdtemp(join(tmpdir(), 'fremkit-companion-socket-app-'))
    await writeFile(join(appDir, 'fremkit.json'), JSON.stringify({
      version: CONFIG_VERSION,
      locale: 'en',
      secrets: { backend: 'file' },
      connections: [],
      widgets: {},
      screens: [{ id: 'edge', name: 'edge', kind: 'edge', display: { cols: 30, rows: 20 }, pages: [{ id: 'home', name: 'Home', items: [] }] }],
    }))
    full = await buildApp({
      accessToken: SECRET,
      port: 4242,
      dataDir: appDir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: 0,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => ['192.0.2.10'] },
    })
  })
  afterEach(async () => {
    await full?.close()
    await rm(appDir, { recursive: true, force: true })
  })

  it('needs no access secret but still checks the Host', async () => {
    const wsHeaders = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', origin: ORIGIN }
    const wrongHost = await full.inject({ method: 'GET', url: '/companion/ws', headers: { ...wsHeaders, host: 'evil.example.com' } })
    expect(wrongHost.statusCode).toBe(421)
  })

  it.skipIf(!hasOpenssl)('the companion socket is 404 on the remote listener', async () => {
    const on = await full.inject({ method: 'PUT', url: '/api/devices/settings', headers: { host: HOST, authorization: `Bearer ${SECRET}` }, payload: { enabled: true } })
    expect(on.statusCode).toBe(200)
    const remotePort = on.json().port as number
    const res = await upgrade(remotePort, { origin: ORIGIN }, `example.local:${remotePort}`, '/companion/ws')
    expect(res.status).toBe(404)
  })
})
