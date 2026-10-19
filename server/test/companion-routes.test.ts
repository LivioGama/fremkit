import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

/** A new install by default: one install may ask three times a minute, and is held back after a refusal. */
function pair(origin: string | undefined, body: unknown = { name: 'Chrome', installId: randomUUID() }) {
  return app.inject({
    method: 'POST',
    url: '/api/companion/pair',
    headers: { host: HOST, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    payload: JSON.stringify(body),
  })
}

function answer(requestId: string, verb: 'approve' | 'refuse', body?: unknown) {
  return app.inject({
    method: 'POST', url: `/api/companion/requests/${requestId}/${verb}`,
    headers: { host: HOST, ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
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
  // Each test starts a minute later, on Date alone: the per-minute counts and a refusal's cooldown
  // start afresh, so no test depends on what the ones before it spent.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 61_000)
  })
  afterAll(async () => {
    vi.useRealTimers()
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

  it('pair takes only a browser name from the closed list', async () => {
    for (const name of ['Approve this, it is safe', 'chrome', 'Firefox', 'Chrome ', 'Safari']) {
      expect((await pair(ORIGIN, { name, installId: INSTALL })).statusCode).toBe(400)
    }
  })

  it('approve without the access secret is 401', async () => {
    const { requestId, code } = (await pair(ORIGIN)).json()
    const res = await app.inject({ method: 'POST', url: `/api/companion/requests/${requestId}/approve`, headers: { host: HOST }, payload: { code } })
    expect(res.statusCode).toBe(401)
    const refuse = await app.inject({ method: 'POST', url: `/api/companion/requests/${requestId}/refuse`, headers: { host: HOST } })
    expect(refuse.statusCode).toBe(401)
    expect((await collect(requestId)).json()).toEqual({ state: 'pending' })
    expect((await answer(requestId, 'refuse', { code })).statusCode).toBe(200)
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

    const approved = await answer(requestId, 'approve', { code })
    expect(approved.statusCode).toBe(200)
    const got = await collect(requestId)
    expect(got.statusCode).toBe(200)
    expect(got.headers['cache-control']).toBe('no-store')
    const body = got.json()
    expect(body).toMatchObject({ state: 'approved' })
    expect(app.pairing.store.findByToken(body.token, 'extension')).toMatchObject({ id: body.deviceId, origin: ORIGIN })
    expect((await collect(requestId)).json()).toEqual({ state: 'expired' })
  })

  it('a GET on the collect route never hands out the token', async () => {
    const { requestId, code } = (await pair(ORIGIN)).json()
    const approved = await answer(requestId, 'approve', { code })
    expect(approved.statusCode).toBe(200)
    for (const headers of [{ host: HOST, origin: ORIGIN }, { host: HOST, origin: ORIGIN, ...auth }]) {
      const res = await app.inject({ method: 'GET', url: `/api/companion/pair/${requestId}`, headers })
      expect([401, 404, 405]).toContain(res.statusCode)
      expect(res.body).not.toMatch(/token/i)
    }
    // Nor did it use the pairing up: the extension still collects its token with a POST.
    expect((await collect(requestId)).json()).toMatchObject({ state: 'approved', token: expect.any(String) })
  })

  it('refuse answers refused, and an unknown request is 404 to approve', async () => {
    const { requestId, code } = (await pair(ORIGIN)).json()
    const refused = await answer(requestId, 'refuse', { code })
    expect(refused.statusCode).toBe(200)
    expect((await collect(requestId)).json()).toEqual({ state: 'refused' })
    const again = await answer(requestId, 'approve', { code })
    expect(again.statusCode).toBe(404)
    expect((await collect('not-a-uuid')).json()).toEqual({ state: 'expired' })
  })

  it('approve and refuse with a missing or other code are 409, and change nothing', async () => {
    const { requestId, code } = (await pair(ORIGIN)).json()
    const other = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ'
    for (const body of [undefined, {}, { code: other }, { code: 7 }]) {
      const res = await answer(requestId, 'approve', body)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'the request changed: check the code' })
      expect((await answer(requestId, 'refuse', body)).statusCode).toBe(409)
    }
    expect((await collect(requestId)).json()).toEqual({ state: 'pending' })
    expect((await answer(requestId, 'refuse', { code })).statusCode).toBe(200)
  })

  it('an answer for a request its install replaced since is 409', async () => {
    const installId = randomUUID()
    const old = (await pair(ORIGIN, { name: 'Chrome', installId })).json()
    const now = (await pair(ORIGIN, { name: 'Chrome', installId })).json()
    expect(now.requestId).not.toBe(old.requestId)
    expect((await answer(old.requestId, 'approve', { code: old.code })).statusCode).toBe(409)
    expect((await collect(now.requestId)).json()).toEqual({ state: 'pending' })
    expect((await answer(now.requestId, 'refuse', { code: now.code })).statusCode).toBe(200)
  })

  it('another install asking while a request waits is 409 busy', async () => {
    const waiting = (await pair(ORIGIN)).json()
    const res = await pair(OTHER)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'another connection request is already waiting on the Edge', reason: 'busy' })
    expect((await answer(waiting.requestId, 'refuse', { code: waiting.code })).statusCode).toBe(200)
  })

  it('an install refused a moment ago is 429 cooldown', async () => {
    const installId = randomUUID()
    const r = (await pair(ORIGIN, { name: 'Microsoft Edge', installId })).json()
    expect((await answer(r.requestId, 'refuse', { code: r.code })).statusCode).toBe(200)
    const res = await pair(ORIGIN, { name: 'Microsoft Edge', installId })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'request refused: try again in a minute', reason: 'cooldown' })
  })

  it('a sixth request within a minute is 429', async () => {
    // Each one answered, so none is turned away as busy.
    let last = 200
    for (let i = 0; i < 6 && last === 200; i++) {
      const res = await pair(ORIGIN)
      last = res.statusCode
      if (last === 200) await answer(res.json().requestId, 'refuse', { code: res.json().code })
    }
    expect(last).toBe(429)
    expect((await pair(ORIGIN)).json()).toMatchObject({ reason: 'limited' })
  })

  it('is 404 to a peer that is not loopback, even on the local listener', async () => {
    // Fails closed if the server is ever bound beyond 127.0.0.1: locality is isLocalRequest.
    const remoteAddress = '192.0.2.5'
    const asked = await app.inject({
      method: 'POST', url: '/api/companion/pair', remoteAddress,
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Chrome', installId: INSTALL }),
    })
    expect(asked.statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/companion/pair/x', remoteAddress, headers: { host: HOST, origin: ORIGIN } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/companion/requests/x/approve', remoteAddress, headers: { host: HOST, ...auth }, payload: { code: 'AAAA' } })).statusCode).toBe(404)
  })

  it.skipIf(!hasOpenssl)('pair on the remote listener is 404', async () => {
    const on = await app.inject({ method: 'PUT', url: '/api/devices/settings', headers: { host: HOST, ...auth }, payload: { enabled: true } })
    expect(on.statusCode).toBe(200)
    const port = on.json().port as number
    const host = `example.local:${port}`
    // A Host the listener answers to, so the 404 is the route's and not the Host check's 421.
    app.pairing.setRemoteHosts(() => new Set([host]))
    const body = JSON.stringify({ name: 'Chrome', installId: INSTALL })
    const res = await remote(port, { method: 'POST', path: '/api/companion/pair', host, headers: { 'content-type': 'application/json', origin: ORIGIN }, body })
    expect(res.status).toBe(404)
    expect((await remote(port, { method: 'POST', path: '/api/companion/pair/x', host, headers: { origin: ORIGIN } })).status).toBe(404)
    expect((await remote(port, { method: 'POST', path: '/api/companion/requests/x/approve', host })).status).toBe(404)
    const off = await app.inject({ method: 'PUT', url: '/api/devices/settings', headers: { host: HOST, ...auth }, payload: { enabled: false } })
    expect(off.statusCode).toBe(200)
  })
})
