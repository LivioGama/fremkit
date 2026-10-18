import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { RemoteListener } from '../src/devices/listener.js'
import { hasOpenssl, remote, tlsMaterial, upgrade } from './helpers/remote.js'

let dir: string
let app: FastifyInstance
let listener: RemoteListener
let tls: { key: string; cert: string }

describe.skipIf(!hasOpenssl)('RemoteListener', () => {
  beforeAll(async () => { tls = await tlsMaterial() })
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-listener-'))
    await mkdir(join(dir, 'widgets'), { recursive: true })
    app = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets') })
    listener = new RemoteListener(app, 0)
  })
  afterEach(async () => {
    await listener.stop()
    // Mutations are queued: one more waits out the un-awaited `touch` a request left behind,
    // so its write does not land in a directory being removed.
    await app.pairing.store.touch('none')
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function start(): Promise<number> {
    await listener.start(tls.key, tls.cert)
    const port = listener.port
    app.pairing.setRemoteHosts(() => new Set([`127.0.0.1:${port}`]))
    return port
  }

  it('reports whether it runs and the port it bound', async () => {
    expect(listener.running).toBe(false)
    const port = await start()
    expect(listener.running).toBe(true)
    expect(port).toBeGreaterThan(0)
    await listener.stop()
    expect(listener.running).toBe(false)
    await expect(remote(port, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('judges a request to https://127.0.0.1 remote: no cookie, 401', async () => {
    const port = await start()
    // The same request on the loopback app answers 200: the socket, not the address, decides.
    expect((await app.inject({ url: '/api/config' })).statusCode).toBe(200)
    const res = await remote(port, { path: '/api/config' })
    expect(res.status).toBe(401)
    expect(res.body).not.toContain('screens')
  })

  it('serves a paired device', async () => {
    const port = await start()
    const { token } = await app.pairing.store.create('iPad', { width: 1180, height: 820 }, null)
    const res = await remote(port, { path: '/api/config', headers: { cookie: `fremkit_device=${token}` } })
    expect(res.status).toBe(200)
    expect(res.body).toContain('screens')
  })

  it('gives plain HTTP on the TLS port nothing', async () => {
    const port = await start()
    const body = await new Promise<string>((resolve) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: '/api/config', agent: false }, (res) => {
        let b = ''
        res.on('data', (c: Buffer) => { b += c.toString() })
        res.on('end', () => resolve(b))
        res.on('error', () => resolve(b))
      })
      r.on('error', () => resolve(''))
      r.end()
    })
    expect(body).not.toContain('screens')
  })

  it('destroys open sockets, upgraded WebSockets included, on stop', async () => {
    const port = await start()
    const { token } = await app.pairing.store.create('iPad', { width: 1180, height: 820 }, null)
    const ws = await upgrade(port, { cookie: `fremkit_device=${token}` })
    expect(ws.status).toBe(101)
    if (!('socket' in ws)) return
    const closed = new Promise<void>((resolve) => ws.socket.once('close', () => resolve()))
    await listener.stop()
    await closed
  })

  it('rejects with EADDRINUSE when the port is taken, and is left stopped', async () => {
    const port = await start()
    const second = new RemoteListener(app, port)
    await expect(second.start(tls.key, tls.cert)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(second.running).toBe(false)
  })
})
