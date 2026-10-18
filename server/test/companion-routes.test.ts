import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { CONFIG_VERSION } from '../src/config/schema.js'
import { noAdvertise } from '../src/devices/bonjour.js'
import { generateToken, isPublicRoute, isCompanionRoute } from '../src/http/access.js'
import { execFileAsync, type Exec } from '../src/secrets/keychain.js'
import { hasOpenssl, remote } from './helpers/remote.js'

const SECRET = generateToken()
const ORIGIN = `chrome-extension://${'c'.repeat(32)}`
const OTHER = `chrome-extension://${'d'.repeat(32)}`
const INSTALL = '0b7d1c2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'
const HOST = '127.0.0.1:4242'

const exec: Exec = (cmd, args) =>
  cmd === 'scutil' ? Promise.resolve({ stdout: 'example\n' }) : execFileAsync(cmd, args)

const CONFIG = {
  version: CONFIG_VERSION,
  locale: 'en',
  secrets: { backend: 'file' },
  connections: [],
  widgets: {},
  screens: [{ id: 'edge', name: 'edge', kind: 'edge', display: { cols: 30, rows: 20 }, pages: [{ id: 'home', name: 'Home', items: [] }] }],
}

let dir: string
let app: FastifyInstance

const auth = { authorization: `Bearer ${SECRET}` }

function pair(origin: string | undefined, body: unknown = { name: 'Chrome', installId: INSTALL }) {
  return app.inject({
    method: 'POST',
    url: '/api/companion/pair',
    headers: { host: HOST, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    payload: JSON.stringify(body),
  })
}

function collect(requestId: string, origin: string | null = ORIGIN) {
  return app.inject({ method: 'POST', url: `/api/companion/pair/${requestId}`, headers: { host: HOST, ...(origin ? { origin } : {}) } })
}

describe('isCompanionRoute', () => {
  it('lists the three routes the extension reaches without the access secret, by method', () => {
    expect(isCompanionRoute('POST', '/api/companion/pair')).toBe(true)
    expect(isCompanionRoute('post', '/api/companion/pair/:requestId')).toBe(true)
    expect(isCompanionRoute('GET', '/companion/ws')).toBe(true)
    expect(isCompanionRoute('GET', '/api/companion/pair')).toBe(false)
    // A GET would arrive without the extension's Origin: Chrome leaves it off.
    expect(isCompanionRoute('GET', '/api/companion/pair/:requestId')).toBe(false)
    expect(isCompanionRoute('HEAD', '/api/companion/pair/:requestId')).toBe(false)
    expect(isCompanionRoute('POST', '/api/companion/requests/:requestId/approve')).toBe(false)
    expect(isCompanionRoute('POST', '/api/companion/pair/abc')).toBe(false)
    expect(isCompanionRoute('GET', undefined)).toBe(false)
    expect(isPublicRoute('POST', '/api/companion/pair')).toBe(false)
  })
})

describe('companion routes', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-companion-routes-'))
    await writeFile(join(dir, 'fremkit.json'), JSON.stringify(CONFIG))
    app = await buildApp({
      accessToken: SECRET,
      port: 4242,
      dataDir: dir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: 0,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => ['192.0.2.10'] },
    })
  })
  afterAll(async () => {
    await app?.close()
    await app?.pairing.store.settled()
    await rm(dir, { recursive: true, force: true })
  })

  it('pair without an extension origin is 403', async () => {
    expect((await pair(undefined)).statusCode).toBe(403)
    expect((await pair('http://127.0.0.1:4242')).statusCode).toBe(403)
    expect((await pair('https://example.com')).statusCode).toBe(403)
    expect((await pair(`chrome-extension://${'q'.repeat(32)}`)).statusCode).toBe(403)
  })

  it('pair still checks the Host', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/companion/pair',
      headers: { host: 'evil.example.com', origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Chrome', installId: INSTALL }),
    })
    expect(res.statusCode).toBe(421)
  })

  it('pair refuses a bad body', async () => {
    expect((await pair(ORIGIN, { name: '', installId: INSTALL })).statusCode).toBe(400)
    expect((await pair(ORIGIN, { name: 'x'.repeat(61), installId: INSTALL })).statusCode).toBe(400)
    expect((await pair(ORIGIN, { name: 'Chrome', installId: 'not-a-uuid' })).statusCode).toBe(400)
    expect((await pair(ORIGIN, { name: 'Chrome', installId: INSTALL, extra: 1 })).statusCode).toBe(400)
  })

  it('approve without the access secret is 401', async () => {
    const { requestId } = (await pair(ORIGIN)).json()
    const res = await app.inject({ method: 'POST', url: `/api/companion/requests/${requestId}/approve`, headers: { host: HOST } })
    expect(res.statusCode).toBe(401)
    const refuse = await app.inject({ method: 'POST', url: `/api/companion/requests/${requestId}/refuse`, headers: { host: HOST } })
    expect(refuse.statusCode).toBe(401)
    expect((await collect(requestId)).json()).toEqual({ state: 'pending' })
  })

  it('pair needs no access secret, and the approved token is handed out once', async () => {
    const res = await pair(ORIGIN)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const { requestId, code, expiresAt } = res.json()
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/)
    expect(typeof expiresAt).toBe('number')

    expect((await collect(requestId)).json()).toEqual({ state: 'pending' })
    expect((await collect(requestId, OTHER)).statusCode).toBe(403)
    expect((await collect(requestId, null)).statusCode).toBe(403)

    const approved = await app.inject({ method: 'POST', url: `/api/companion/requests/${requestId}/approve`, headers: { host: HOST, ...auth } })
    expect(approved.statusCode).toBe(200)
    const got = await collect(requestId)
    expect(got.statusCode).toBe(200)
    expect(got.headers['cache-control']).toBe('no-store')
    const body = got.json()
    expect(body).toMatchObject({ state: 'approved' })
    expect(app.pairing.store.findByToken(body.token, 'extension')).toMatchObject({ id: body.deviceId, origin: ORIGIN })
    expect((await collect(requestId)).json()).toEqual({ state: 'expired' })
  })

  it('refuse answers refused, and an unknown request is 404 to approve', async () => {
    const { requestId } = (await pair(ORIGIN)).json()
    const refused = await app.inject({ method: 'POST', url: `/api/companion/requests/${requestId}/refuse`, headers: { host: HOST, ...auth } })
    expect(refused.statusCode).toBe(200)
    expect((await collect(requestId)).json()).toEqual({ state: 'refused' })
    const again = await app.inject({ method: 'POST', url: `/api/companion/requests/${requestId}/approve`, headers: { host: HOST, ...auth } })
    expect(again.statusCode).toBe(404)
    expect((await collect('not-a-uuid')).json()).toEqual({ state: 'expired' })
  })

  it('a sixth request within a minute is 429', async () => {
    // Earlier tests already spent part of the minute; whatever is left runs out here.
    let last = 200
    for (let i = 0; i < 6 && last === 200; i++) last = (await pair(ORIGIN)).statusCode
    expect(last).toBe(429)
  })

  it.skipIf(!hasOpenssl)('pair on the remote listener is 404', async () => {
    const on = await app.inject({ method: 'PUT', url: '/api/devices/settings', headers: { host: HOST, ...auth }, payload: { enabled: true } })
    expect(on.statusCode).toBe(200)
    const port = on.json().port as number
    const host = `example.local:${port}`
    const body = JSON.stringify({ name: 'Chrome', installId: INSTALL })
    const res = await remote(port, { method: 'POST', path: '/api/companion/pair', host, headers: { 'content-type': 'application/json', origin: ORIGIN }, body })
    expect(res.status).toBe(404)
    expect((await remote(port, { method: 'POST', path: '/api/companion/pair/x', host, headers: { origin: ORIGIN } })).status).toBe(404)
    expect((await remote(port, { method: 'POST', path: '/api/companion/requests/x/approve', host })).status).toBe(404)
    const off = await app.inject({ method: 'PUT', url: '/api/devices/settings', headers: { host: HOST, ...auth }, payload: { enabled: false } })
    expect(off.statusCode).toBe(200)
  })
})
