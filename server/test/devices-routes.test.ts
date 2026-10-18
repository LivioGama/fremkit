import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { CONFIG_VERSION } from '../src/config/schema.js'
import { noAdvertise } from '../src/devices/bonjour.js'
import { RemoteListener } from '../src/devices/listener.js'
import { execFileAsync, type Exec } from '../src/secrets/keychain.js'
import { Hub } from '../src/ws/hub.js'
import { DeviceStore } from '../src/devices/store.js'
import { DeviceService } from '../src/devices/service.js'
import { PairingCodes } from '../src/devices/codes.js'
import { readZip } from '../src/backup/zip.js'
import { readKey, spkiHash, TLS_KEY_SECRET } from '../src/devices/certificate.js'
import { FileSecretStore } from '../src/secrets/file.js'
import { hasOpenssl, remote } from './helpers/remote.js'

const ADDRESS = '192.0.2.10'

/** `scutil` answers a fixed name; `openssl` is the real one. */
const exec: Exec = (cmd, args) =>
  cmd === 'scutil' ? Promise.resolve({ stdout: 'example\n' }) : execFileAsync(cmd, args)

const screen = (id: string, kind: 'edge' | 'device', viewport?: { width: number; height: number }) => ({
  id, name: id, kind,
  display: { cols: 30, rows: 20, ...(viewport ? { viewport } : {}) },
  pages: [{ id: 'home', name: 'Home', items: [] }],
})

const CONFIG = {
  version: CONFIG_VERSION,
  locale: 'en',
  secrets: { backend: 'file' },
  connections: [],
  widgets: {},
  screens: [
    screen('edge', 'edge'),
    screen('ipad', 'device', { width: 1180, height: 820 }),
    screen('tab-a', 'device', { width: 1024, height: 768 }),
    screen('tab-b', 'device', { width: 768, height: 1024 }),
  ],
}

let dir: string
let app: FastifyInstance
let port: number

const host = () => `example.local:${port}`
const cookie = (t: string) => ({ cookie: `fremkit_device=${t}` })
const json = { 'content-type': 'application/json' }

async function issueCode(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/devices/code' })
  expect(res.statusCode).toBe(200)
  return res.json().code as string
}

function pair(body: unknown) {
  return remote(port, { method: 'POST', path: '/api/pair', host: host(), headers: json, body: JSON.stringify(body) })
}

async function pairWith(viewport: { width: number; height: number }, name = 'iPad'): Promise<{ token: string; deviceId: string }> {
  const code = await issueCode()
  // Typed by hand, in lower case and with spaces: the route normalises it.
  const res = await pair({ code: ` ${code.toLowerCase()} `, name, viewport })
  expect(res.status).toBe(200)
  return JSON.parse(res.body)
}

async function me(token: string) {
  return remote(port, { path: '/api/devices/me?id=someone-else', host: host(), headers: cookie(token) })
}

describe.skipIf(!hasOpenssl)('device routes', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-devices-'))
    await writeFile(join(dir, 'fremkit.json'), JSON.stringify(CONFIG))
    app = await buildApp({
      accessToken: null,
      dataDir: dir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: 0,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => [ADDRESS] },
    })
    const on = await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
    expect(on.statusCode).toBe(200)
    expect(on.json()).toMatchObject({ enabled: true, listening: true, error: null })
    port = on.json().port
    expect(port).toBeGreaterThan(0)
  })
  afterAll(async () => {
    await app?.close()
    await app?.pairing.store.settled()
    await rm(dir, { recursive: true, force: true })
  })

  it('offers a code and a QR payload carrying the pin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/devices/code' })
    const offer = res.json()
    expect(offer.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    const status = (await app.inject({ url: '/api/devices' })).json()
    expect(offer.url).toBe(`fremkit://pair?h=example.local&a=${ADDRESS}&p=${port}&c=${offer.code}&k=${status.keyHash}`)
    expect(status.keyHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('pairs a device and tells it its screen', async () => {
    const { token, deviceId } = await pairWith({ width: 1180, height: 820 })
    const res = await me(token)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ id: deviceId, name: 'iPad', screenId: 'ipad' })
  })

  it('attaches by viewport in either orientation, and only when one screen fits', async () => {
    const rotated = await pairWith({ width: 820, height: 1180 })
    expect(JSON.parse((await me(rotated.token)).body).screenId).toBe('ipad')
    // 1024 × 768 fits both tab-a and tab-b (rotated): ambiguous, left for the user.
    const two = await pairWith({ width: 1024, height: 768 })
    expect(JSON.parse((await me(two.token)).body).screenId).toBeNull()
    const none = await pairWith({ width: 640, height: 480 })
    expect(JSON.parse((await me(none.token)).body).screenId).toBeNull()
  })

  it('validates the pairing body', async () => {
    await issueCode()
    expect((await pair({ code: 'AAAA', name: '', viewport: { width: 1, height: 1 } })).status).toBe(400)
    expect((await pair({ code: 'AAAA', name: 'x'.repeat(61), viewport: { width: 1, height: 1 } })).status).toBe(400)
    expect((await pair({ code: 'AAAA', name: 'x', viewport: { width: 0, height: 1 } })).status).toBe(400)
  })

  it('refuses to attach a device to a screen that is not a device screen', async () => {
    const { deviceId } = await pairWith({ width: 640, height: 480 })
    const edge = await app.inject({ method: 'PATCH', url: `/api/devices/${deviceId}`, payload: { screenId: 'edge' } })
    expect(edge.statusCode).toBe(400)
    expect(edge.json().errors).toEqual(['this screen does not exist or is not a device screen'])
    const ok = await app.inject({ method: 'PATCH', url: `/api/devices/${deviceId}`, payload: { screenId: 'tab-a', name: 'Kitchen' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ id: deviceId, screenId: 'tab-a', name: 'Kitchen' })
    expect((await app.inject({ method: 'PATCH', url: '/api/devices/nope', payload: { name: 'x' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: `/api/devices/${deviceId}`, payload: { name: '' } })).statusCode).toBe(400)
  })

  it('detaches devices whose screen is saved away', async () => {
    const { token } = await pairWith({ width: 1180, height: 820 })
    expect(JSON.parse((await me(token)).body).screenId).toBe('ipad')
    const current = (await app.inject({ url: '/api/config' })).json()
    const saved = await app.inject({
      method: 'PUT', url: '/api/config',
      payload: { ...current, screens: current.screens.filter((s: { id: string }) => s.id !== 'ipad') },
    })
    expect(saved.statusCode).toBe(200)
    await expect.poll(async () => JSON.parse((await me(token)).body).screenId).toBeNull()
  })

  it('lists devices without a token hash or the key', async () => {
    const res = await app.inject({ url: '/api/devices' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.devices.length).toBeGreaterThan(0)
    expect(res.body).not.toContain('tokenHash')
    expect(res.body).not.toContain('PRIVATE KEY')
    expect(body).toMatchObject({ host: 'example.local', addresses: [ADDRESS], port, guessing: false })
  })

  it('revokes a device: its token stops working', async () => {
    const { token, deviceId } = await pairWith({ width: 640, height: 480 })
    const closeDevice = vi.spyOn(Hub.prototype, 'closeDevice')
    try {
      expect((await me(token)).status).toBe(200)
      expect((await app.inject({ method: 'DELETE', url: `/api/devices/${deviceId}` })).statusCode).toBe(204)
      expect((await me(token)).status).toBe(401)
      expect(closeDevice).toHaveBeenCalledWith(deviceId)
      expect((await app.inject({ method: 'DELETE', url: `/api/devices/${deviceId}` })).statusCode).toBe(404)
    } finally {
      closeDevice.mockRestore()
    }
  })

  it('answers each audience only where it belongs', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/pair', payload: { code: 'X', name: 'x', viewport: { width: 1, height: 1 } } })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/devices/me' })).statusCode).toBe(404)
    const { token } = await pairWith({ width: 640, height: 480 })
    for (const [method, path] of [
      ['GET', '/api/devices'], ['POST', '/api/devices/code'], ['PUT', '/api/devices/settings'],
      ['DELETE', '/api/devices'], ['POST', '/api/devices/reset-certificate'],
    ]) {
      const body = method === 'GET' || method === 'DELETE' ? {} : { headers: { ...cookie(token), ...json }, body: '{}' }
      const res = await remote(port, { method, path, host: host(), headers: cookie(token), ...body })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })

  it('keeps devices out of the backup', async () => {
    const res = await app.inject({ url: '/api/backup' })
    expect(res.statusCode).toBe(200)
    const entries = readZip(Buffer.from(res.rawPayload))
    expect(entries.map((e) => e.name).some((n) => n.includes('devices'))).toBe(false)
    expect(Buffer.concat(entries.map((e) => e.data)).toString('utf8')).not.toContain('tokenHash')
  })

  it('keeps the TLS key, in either form, out of the backup and the config', async () => {
    const secrets = new FileSecretStore(join(dir, 'secrets.json'))
    const stored = await secrets.get(TLS_KEY_SECRET)
    const pem = await readKey(secrets)
    expect(stored).toMatch(/^[A-Za-z0-9+/=]{40,}$/)
    expect(pem).toContain('PRIVATE KEY')
    // The PEM's body lines, the one-line stored form, and pieces of it long enough to mean it.
    const pemLines = pem!.split('\n').filter((l) => l.length > 0 && !l.startsWith('-----'))
    const needles = [stored!, stored!.slice(0, 32), stored!.slice(-32), ...pemLines, 'PRIVATE KEY', TLS_KEY_SECRET]

    const backup = await app.inject({ url: '/api/backup' })
    expect(backup.statusCode).toBe(200)
    const entries = readZip(Buffer.from(backup.rawPayload))
    const texts = [...entries.map((e) => e.data.toString('utf8')), ...entries.map((e) => e.data.toString('base64'))]
    const config = await app.inject({ url: '/api/config' })
    expect(config.statusCode).toBe(200)
    const { token } = await pairWith({ width: 640, height: 480 })
    const remoteConfig = await remote(port, { path: '/api/config', host: host(), headers: cookie(token) })
    expect(remoteConfig.status).toBe(200)
    for (const text of [...texts, config.body, remoteConfig.body]) {
      for (const needle of needles) expect(text.includes(needle), needle.slice(0, 12)).toBe(false)
    }
  })

  it('answers /me with the asking device only', async () => {
    const a = await pairWith({ width: 640, height: 480 }, 'Kitchen')
    const b = await pairWith({ width: 640, height: 480 }, 'Hall')
    expect((await app.inject({ method: 'PATCH', url: `/api/devices/${b.deviceId}`, payload: { screenId: 'tab-a' } })).statusCode).toBe(200)
    const meA = JSON.parse((await me(a.token)).body)
    const meB = JSON.parse((await me(b.token)).body)
    expect(meA).toEqual({ id: a.deviceId, name: 'Kitchen', screenId: null })
    expect(meB).toEqual({ id: b.deviceId, name: 'Hall', screenId: 'tab-a' })
    // Whatever the query asks for.
    const asked = await remote(port, { path: `/api/devices/me?id=${b.deviceId}`, host: host(), headers: cookie(a.token) })
    expect(JSON.parse(asked.body).id).toBe(a.deviceId)
  })

  it('resetting the certificate changes the pin and unpairs every device', async () => {
    const { token, deviceId } = await pairWith({ width: 640, height: 480 })
    const before = (await app.inject({ url: '/api/devices' })).json().keyHash as string
    const closeDevice = vi.spyOn(Hub.prototype, 'closeDevice')
    const closeRemote = vi.spyOn(Hub.prototype, 'closeRemote')
    const drop = vi.spyOn(RemoteListener.prototype, 'dropConnections')
    try {
      const res = await app.inject({ method: 'POST', url: '/api/devices/reset-certificate' })
      expect(res.statusCode).toBe(200)
      expect(res.json().keyHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(res.json().keyHash).not.toBe(before)
      expect(res.json().devices).toEqual([])
      expect(res.json().listening).toBe(true)
      expect((await me(token)).status).toBe(401)
      expect(closeDevice).toHaveBeenCalledWith(deviceId)
      expect(closeRemote).toHaveBeenCalled()
      // No keep-alive connection is left talking over the old key.
      expect(drop).toHaveBeenCalledTimes(1)
    } finally {
      closeDevice.mockRestore()
      closeRemote.mockRestore()
      drop.mockRestore()
    }
  })

  it('refuses every code after five wrong ones in a minute', async () => {
    const code = await issueCode()
    const wrong = code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'
    const viewport = { width: 640, height: 480 }
    for (let i = 0; i < 5; i++) {
      const res = await pair({ code: wrong, name: 'x', viewport })
      expect(res.status).toBe(403)
      expect(JSON.parse(res.body).error).toBe('wrong pairing code')
    }
    const limited = await pair({ code, name: 'x', viewport })
    expect(limited.status).toBe(429)
    expect(JSON.parse(limited.body).error).toBe('too many wrong codes: try again in a minute')
    expect((await app.inject({ url: '/api/devices' })).json().guessing).toBe(true)
  })

  // Last: it turns remote access off.
  it('turning it off stops the listener and closes every paired socket', async () => {
    const closeRemote = vi.spyOn(Hub.prototype, 'closeRemote')
    try {
      const off = await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: false } })
      expect(off.statusCode).toBe(200)
      expect(off.json()).toMatchObject({ enabled: false, listening: false })
      expect(closeRemote).toHaveBeenCalled()
      await expect(remote(port, { path: '/', host: host() })).rejects.toThrow()
      expect((await app.inject({ method: 'POST', url: '/api/devices/code' })).statusCode).toBe(409)
      expect((await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: 'yes' } })).statusCode).toBe(400)
    } finally {
      closeRemote.mockRestore()
    }
  })
})

describe.skipIf(!hasOpenssl)('a remote port already taken', () => {
  let taken: Server
  let tdir: string
  let tapp: FastifyInstance
  beforeAll(async () => {
    taken = createServer()
    await new Promise<void>((resolve) => taken.listen(0, resolve))
    tdir = await mkdtemp(join(tmpdir(), 'fremkit-devices-port-'))
    await writeFile(join(tdir, 'fremkit.json'), JSON.stringify(CONFIG))
    tapp = await buildApp({
      accessToken: null,
      dataDir: tdir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: (taken.address() as AddressInfo).port,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => [ADDRESS] },
    })
  })
  afterAll(async () => {
    await tapp?.close()
    await new Promise((resolve) => taken.close(resolve))
    await rm(tdir, { recursive: true, force: true })
  })

  it('falls back to off and says why', async () => {
    const res = await tapp.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ enabled: false, listening: false, error: 'portInUse', message: 'the remote access port is already used by another application' })
    expect(tapp.pairing.store.enabled).toBe(false)
  })
})

describe.skipIf(!hasOpenssl)('following a change of address', () => {
  let adir: string
  let aapp: FastifyInstance
  let addresses = ['192.0.2.10']

  beforeAll(async () => {
    adir = await mkdtemp(join(tmpdir(), 'fremkit-devices-addr-'))
    await writeFile(join(adir, 'fremkit.json'), JSON.stringify(CONFIG))
    aapp = await buildApp({
      accessToken: null,
      dataDir: adir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: 0,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => addresses, preferredAddress: async (a) => a[0] ?? null },
    })
  })
  afterAll(async () => {
    vi.useRealTimers()
    await aapp?.close()
    await rm(adir, { recursive: true, force: true })
  })

  it('re-issues the certificate from the same key every 30 s when the addresses move, and stops checking when off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const setCertificate = vi.spyOn(RemoteListener.prototype, 'setCertificate')
    try {
      const before = vi.getTimerCount()
      const on = await aapp.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
      expect(on.json()).toMatchObject({ enabled: true, listening: true })
      const aport = on.json().port as number
      const keyHash = on.json().keyHash as string
      expect(vi.getTimerCount()).toBe(before + 1)
      expect((await remote(aport, { path: '/', host: `192.0.2.10:${aport}` })).status).not.toBe(421)
      expect((await remote(aport, { path: '/', host: `198.51.100.7:${aport}` })).status).toBe(421)

      // Nothing moved: the tick changes nothing.
      vi.advanceTimersByTime(30_000)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(setCertificate).not.toHaveBeenCalled()

      addresses = ['198.51.100.7']
      vi.advanceTimersByTime(29_999)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(setCertificate).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      await expect.poll(() => setCertificate.mock.calls.length).toBe(1)

      const cert = new X509Certificate(setCertificate.mock.calls[0][1])
      expect(cert.subjectAltName).toContain('IP Address:198.51.100.7')
      expect(cert.subjectAltName).not.toContain('192.0.2.10')
      // Same key, so the pin every paired device holds still matches.
      expect(spkiHash(cert.toString())).toBe(keyHash)
      expect((await aapp.inject({ url: '/api/devices' })).json().keyHash).toBe(keyHash)
      // The gate follows: the new authority is in, the old one out.
      expect((await remote(aport, { path: '/', host: `198.51.100.7:${aport}` })).status).not.toBe(421)
      expect((await remote(aport, { path: '/', host: `192.0.2.10:${aport}` })).status).toBe(421)

      const off = await aapp.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: false } })
      expect(off.json()).toMatchObject({ enabled: false, listening: false })
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      setCertificate.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('browser extensions in the device list', () => {
  const ORIGIN = `chrome-extension://${'e'.repeat(32)}`
  const INSTALL = '3a9c1d2e-5b6f-4a7b-8c9d-0e1f2a3b4c5d'
  const HOST = '127.0.0.1:4242'
  let edir: string
  let eapp: FastifyInstance

  async function pairExtension(): Promise<{ requestId: string; deviceId: string }> {
    const asked = await eapp.inject({
      method: 'POST', url: '/api/companion/pair',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Chrome', installId: INSTALL }),
    })
    const { requestId } = asked.json()
    const status = (await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json()
    expect(status.companionRequest).toMatchObject({ requestId, name: 'Chrome' })
    expect((await eapp.inject({ method: 'POST', url: `/api/companion/requests/${requestId}/approve`, headers: { host: HOST } })).statusCode).toBe(200)
    const collected = (await eapp.inject({ method: 'POST', url: `/api/companion/pair/${requestId}`, headers: { host: HOST, origin: ORIGIN } })).json()
    return { requestId, deviceId: collected.deviceId }
  }

  beforeAll(async () => {
    edir = await mkdtemp(join(tmpdir(), 'fremkit-devices-ext-'))
    await writeFile(join(edir, 'fremkit.json'), JSON.stringify(CONFIG))
    eapp = await buildApp({
      accessToken: null,
      port: 4242,
      dataDir: edir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: 0,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => [ADDRESS] },
    })
  })
  afterAll(async () => {
    await eapp?.close()
    await eapp?.pairing.store.settled()
    await rm(edir, { recursive: true, force: true })
  })

  it('status lists extension devices and the pending request without tokens', async () => {
    expect((await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json().companionRequest).toBeNull()
    const asked = await eapp.inject({
      method: 'POST', url: '/api/companion/pair',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Chrome', installId: INSTALL }),
    })
    const { requestId, code } = asked.json()
    const waiting = (await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json()
    expect(waiting.companionRequest).toEqual({ requestId, code, name: 'Chrome', expiresAt: expect.any(Number) })

    const { deviceId } = await pairExtension()
    const done = (await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json()
    expect(done.devices).toEqual([expect.objectContaining({ id: deviceId, kind: 'extension', name: 'Chrome', origin: ORIGIN, connected: false })])
    expect(JSON.stringify(done)).not.toMatch(/token/i)
  })

  it('renames an extension, and refuses to put it on a screen', async () => {
    const { deviceId } = await pairExtension()
    const renamed = await eapp.inject({ method: 'PATCH', url: `/api/devices/${deviceId}`, headers: { host: HOST }, payload: { name: 'Work Chrome' } })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({ id: deviceId, kind: 'extension', name: 'Work Chrome' })
    const screen = await eapp.inject({ method: 'PATCH', url: `/api/devices/${deviceId}`, headers: { host: HOST }, payload: { screenId: 'ipad' } })
    expect(screen.statusCode).toBe(400)
    const status = (await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json()
    expect(status.devices.find((d: { id: string }) => d.id === deviceId)).not.toHaveProperty('screenId')
    expect((await eapp.inject({ method: 'PATCH', url: '/api/devices/nobody', headers: { host: HOST }, payload: { name: 'x' } })).statusCode).toBe(404)
  })

  it('removes an extension like any device', async () => {
    const { deviceId } = await pairExtension()
    expect((await eapp.inject({ method: 'DELETE', url: `/api/devices/${deviceId}`, headers: { host: HOST } })).statusCode).toBe(204)
    const status = (await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json()
    expect(status.devices.find((d: { id: string }) => d.id === deviceId)).toBeUndefined()
  })
})

describe('the device status reads the companion through its closures', () => {
  it('marks an extension connected when its socket is open, and carries the request', async () => {
    const sdir = await mkdtemp(join(tmpdir(), 'fremkit-devices-status-'))
    try {
      const store = new DeviceStore(join(sdir, 'devices.json'))
      await store.load()
      const { device } = await store.createExtension({ name: 'Chrome', origin: `chrome-extension://${'f'.repeat(32)}`, installId: '3a9c1d2e-5b6f-4a7b-8c9d-0e1f2a3b4c5d' })
      let open = new Set<string>()
      const service = new DeviceService({
        app: { log: { warn() {} } } as never,
        store, codes: new PairingCodes(), secrets: {} as never, config: {} as never, hub: {} as never, catalog: {} as never,
        lanAddresses: () => [],
        companionRequest: () => ({ requestId: 'r1', code: 'AB2C', name: 'Chrome', expiresAt: 5, token: 'secret' } as never),
        companionConnected: () => open,
      })
      expect(service.status().devices[0]).toMatchObject({ id: device.id, connected: false })
      open = new Set([device.id])
      expect(service.status().devices[0]).toMatchObject({ id: device.id, connected: true })
      expect(service.status().companionRequest).toEqual({ requestId: 'r1', code: 'AB2C', name: 'Chrome', expiresAt: 5 })
    } finally {
      await rm(sdir, { recursive: true, force: true })
    }
  })
})
