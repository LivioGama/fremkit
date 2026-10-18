import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { RemoteListener } from '../src/devices/listener.js'
import { commandScope, deviceConfigView, instanceInScope, widgetInScope, type ScreenScope } from '../src/devices/scope.js'
import { ConfigSchema, type Config } from '../src/config/schema.js'
import { hasOpenssl, remote, tlsMaterial, TinyWs, upgrade } from './helpers/remote.js'

/**
 * Three screens: the Edge, and two device screens. Each shows its own clock and its own
 * service-status tile, so every cross-screen case has an instance of the right widget to name.
 */
const RAW_CONFIG = {
  version: 4,
  locale: 'en',
  widgets: {
    'clock-edge': { widgetId: 'clock', settings: {} },
    'clock-a': { widgetId: 'clock', settings: {} },
    'clock-b': { widgetId: 'clock', settings: {} },
    'status-edge': { widgetId: 'service-status', settings: { services: [] } },
    'status-a': { widgetId: 'service-status', settings: { services: [] } },
    'status-b': { widgetId: 'service-status', settings: { services: [] } },
    'only-edge': { widgetId: 'edgeonly', settings: {} },
    'docky-b': { widgetId: 'docky', settings: {} },
  },
  screens: [
    { id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16 }, nav: [],
      pages: [{ id: 'p', name: 'P', items: [
        { instanceId: 'clock-edge', x: 0, y: 0, w: 8, h: 4 },
        { instanceId: 'status-edge', x: 8, y: 0, w: 8, h: 4 },
        { instanceId: 'only-edge', x: 16, y: 0, w: 8, h: 4 },
      ] }] },
    { id: 'tab-a', name: 'Tablet A', kind: 'device', display: { cols: 34, rows: 23 }, nav: [],
      pages: [{ id: 'p', name: 'P', items: [
        { instanceId: 'clock-a', x: 0, y: 0, w: 8, h: 4 },
        { instanceId: 'status-a', x: 8, y: 0, w: 8, h: 4 },
      ] }] },
    { id: 'tab-b', name: 'Tablet B', kind: 'device', display: { cols: 34, rows: 23 },
      nav: [{ instanceId: 'status-b' }],
      pages: [{ id: 'p', name: 'P', items: [
        { instanceId: 'clock-b', x: 0, y: 0, w: 8, h: 4 },
        { instanceId: 'docky-b', x: 8, y: 0, w: 8, h: 4 },
      ] }] },
  ],
}

const config = (): Config => ConfigSchema.parse(RAW_CONFIG)

describe('screen scope', () => {
  const a: ScreenScope = { kind: 'screen', screenId: 'tab-a' }
  const b: ScreenScope = { kind: 'screen', screenId: 'tab-b' }

  it('lets everything in for this Mac and nothing for a device with no screen', () => {
    expect(instanceInScope(config(), { kind: 'all' }, 'clock-b')).toBe(true)
    expect(instanceInScope(config(), { kind: 'none' }, 'clock-a')).toBe(false)
    expect(widgetInScope(config(), { kind: 'none' }, 'clock')).toBe(false)
  })

  it('narrows a device to the instances on its own screen, its bar included', () => {
    expect(instanceInScope(config(), a, 'clock-a')).toBe(true)
    expect(instanceInScope(config(), a, 'clock-b')).toBe(false)
    expect(instanceInScope(config(), a, 'clock-edge')).toBe(false)
    expect(instanceInScope(config(), b, 'status-b')).toBe(true)
    expect(instanceInScope(config(), b, 'constructor')).toBe(false)
    expect(widgetInScope(config(), a, 'clock')).toBe(true)
    expect(widgetInScope(config(), a, 'edgeonly')).toBe(false)
    expect(widgetInScope(config(), { kind: 'screen', screenId: 'gone' }, 'clock')).toBe(false)
  })

  it('scopes a command by its socket, failing closed', () => {
    const screenOf = (id: string) => (id === 'dev-a' ? 'tab-a' : null)
    expect(commandScope({ loopback: true, paired: false }, screenOf)).toEqual({ kind: 'all' })
    expect(commandScope({ loopback: false, paired: true, deviceId: 'dev-a' }, screenOf)).toEqual(a)
    expect(commandScope({ loopback: false, paired: true, deviceId: 'dev-x' }, screenOf)).toEqual({ kind: 'none' })
    expect(commandScope({ loopback: false, paired: true }, screenOf)).toEqual({ kind: 'none' })
    expect(commandScope({ loopback: false, paired: false }, screenOf)).toEqual({ kind: 'none' })
    expect(commandScope(undefined, screenOf)).toEqual({ kind: 'none' })
    expect(commandScope({ loopback: false, paired: true, deviceId: 'dev-a' }, () => { throw new Error('x') })).toEqual({ kind: 'none' })
  })
})

describe('deviceConfigView', () => {
  it('keeps its screen, the instances it shows, and what drawing it takes', () => {
    const view = deviceConfigView(config(), 'tab-b')
    expect(Object.keys(view).sort()).toEqual(['locale', 'screens', 'theme', 'version', 'widgets'])
    expect(view.screens.map((s) => s.id)).toEqual(['tab-b'])
    expect(Object.keys(view.widgets).sort()).toEqual(['clock-b', 'docky-b', 'status-b'])
  })
  it('has no screen and no instance for a device with none, or a screen that is gone', () => {
    for (const id of [null, 'gone']) {
      const view = deviceConfigView(config(), id)
      expect(view.screens).toEqual([])
      expect(view.widgets).toEqual({})
    }
  })
})

/** What a device must never read in the config, whatever its screen. */
const MAC_ONLY = ['connections', 'secrets', 'marketplace', 'privacy']

describe.skipIf(!hasOpenssl)('a paired device acts on its own screen only', () => {
  let dir: string
  let app: FastifyInstance
  let listener: RemoteListener
  let port: number
  let tokenA: string
  let tokenNone: string
  let tokenB: string
  const cookie = (t: string): Record<string, string> => ({ cookie: `fremkit_device=${t}` })

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-scope-'))
    const widget = async (id: string, manifest: Record<string, unknown>) => {
      await mkdir(join(dir, 'widgets', id), { recursive: true })
      await writeFile(join(dir, 'widgets', id, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', minSize: [4, 2], defaultSize: [8, 4], ...manifest }))
      await writeFile(join(dir, 'widgets', id, 'index.html'), '<!doctype html><title>w</title>')
    }
    await widget('clock', {})
    await widget('edgeonly', {})
    await widget('docky', { subscriptions: ['dock'] })
    await widget('service-status', { commands: ['service-status'], compact: { width: 4 } })
    await mkdir(join(dir, 'data'), { recursive: true })
    await writeFile(join(dir, 'data', 'fremkit.json'), JSON.stringify(RAW_CONFIG))
    app = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets') })
    listener = new RemoteListener(app, 0)
    const { key, cert } = await tlsMaterial()
    await listener.start(key, cert)
    port = listener.port
    app.pairing.setRemoteHosts(() => new Set([`127.0.0.1:${port}`]))
    ;({ token: tokenA } = await app.pairing.store.create('iPad A', { width: 1180, height: 820 }, 'tab-a'))
    ;({ token: tokenNone } = await app.pairing.store.create('iPad', { width: 1180, height: 820 }, null))
    ;({ token: tokenB } = await app.pairing.store.create('iPad B', { width: 1180, height: 820 }, 'tab-b'))
  })
  afterAll(async () => {
    await listener?.stop()
    await app?.pairing.store.touch('none')
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  })

  const conn = (token: string, widgetId: string, instanceId: string) => remote(port, {
    method: 'POST', path: `/api/proxy/${widgetId}/conn`,
    headers: { ...cookie(token), 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId, method: 'GET', path: '/x' }),
  })

  it('refuses the proxy on an instance of another screen, and on any instance for a device with no screen', async () => {
    for (const instanceId of ['clock-edge', 'clock-b']) {
      const res = await conn(tokenA, 'clock', instanceId)
      expect(res.status, instanceId).toBe(404)
    }
    for (const instanceId of ['clock-a', 'clock-edge']) {
      expect((await conn(tokenNone, 'clock', instanceId)).status, instanceId).toBe(404)
    }
  })

  it('lets the proxy through on an instance of its own screen', async () => {
    // Past the scope: refused further on, because the fixture's clock declares no connection.
    const res = await conn(tokenA, 'clock', 'clock-a')
    expect(res.status).toBe(403)
  })

  it('refuses the GET proxy for a widget its screen does not show', async () => {
    expect((await remote(port, { path: '/api/proxy/edgeonly', headers: cookie(tokenA) })).status).toBe(404)
    expect((await remote(port, { path: '/api/proxy/clock', headers: cookie(tokenNone) })).status).toBe(404)
    // Its own: past the scope, refused for the missing `url`.
    expect((await remote(port, { path: '/api/proxy/clock', headers: cookie(tokenA) })).status).toBe(400)
  })

  it('leaves the proxy alone for this Mac', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/proxy/clock/conn', payload: { instanceId: 'clock-b', method: 'GET', path: '/x' } })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/proxy/edgeonly' })).statusCode).toBe(400)
  })

  it('reads its own screen of the config, and nothing of the Mac\'s', async () => {
    const own = JSON.parse((await remote(port, { path: '/api/config', headers: cookie(tokenA) })).body)
    for (const key of MAC_ONLY) expect(own, key).not.toHaveProperty(key)
    expect(own.screens.map((s: { id: string }) => s.id)).toEqual(['tab-a'])
    expect(Object.keys(own.widgets).sort()).toEqual(['clock-a', 'status-a'])
    expect(own.locale).toBe('en')
    expect(typeof own.theme).toBe('string')

    const none = JSON.parse((await remote(port, { path: '/api/config', headers: cookie(tokenNone) })).body)
    for (const key of MAC_ONLY) expect(none, key).not.toHaveProperty(key)
    expect(none.screens).toEqual([])
    expect(none.widgets).toEqual({})

    // This Mac still reads all of it.
    const local = (await app.inject({ url: '/api/config' })).json()
    expect(local.screens).toHaveLength(3)
    expect(local).toHaveProperty('connections')
  })

  it('hears its own screen of the config on the WebSocket', async () => {
    const opened = await upgrade(port, { ...cookie(tokenA), origin: `https://127.0.0.1:${port}` })
    if (!('socket' in opened)) throw new Error(`no upgrade: ${opened.status}`)
    const ws = new TinyWs(opened.socket, opened.head)
    try {
      ws.send({ type: 'subscribe', channel: 'config' })
      const msg = await ws.next((m) => m.channel === 'config')
      for (const key of MAC_ONLY) expect(msg.data, key).not.toHaveProperty(key)
      expect(msg.data.screens.map((s: { id: string }) => s.id)).toEqual(['tab-a'])
    } finally {
      ws.close()
    }
  })

  it('reads only the catalogue of its own screen, without scan errors or un-narrowed asks', async () => {
    const res = JSON.parse((await remote(port, { path: '/api/widgets', headers: cookie(tokenA) })).body)
    expect(res.errors).toEqual([])
    expect(res.asks).toEqual({})
    expect(Object.keys(res.widgets).sort()).toEqual(['clock', 'service-status'])
    expect(Object.keys(res.sources).sort()).toEqual(['clock', 'service-status'])
    // Its bar counts: tablet B shows service-status only there.
    const b = JSON.parse((await remote(port, { path: '/api/widgets', headers: cookie(tokenB) })).body)
    expect(Object.keys(b.widgets).sort()).toEqual(['clock', 'docky', 'service-status'])
    const none = JSON.parse((await remote(port, { path: '/api/widgets', headers: cookie(tokenNone) })).body)
    expect(none.widgets).toEqual({})
    expect(none.sources).toEqual({})
    // This Mac still reads all of it.
    expect(Object.keys((await app.inject({ url: '/api/widgets' })).json().widgets)).toContain('edgeonly')
  })

  it('is refused app icons on the same terms as the list', async () => {
    const icon = (token: string) => remote(port, { path: '/api/apps/icon/com.example.none', headers: cookie(token) })
    expect((await icon(tokenA)).status).toBe(403)
    expect((await icon(tokenNone)).status).toBe(403)
    // Past the rule: no such application here, so no icon.
    expect((await icon(tokenB)).status).toBe(404)
    expect((await app.inject({ url: '/api/apps/icon/com.example.none' })).statusCode).toBe(404)
  })

  it('is refused the installed applications unless its screen shows a widget that may read them', async () => {
    // Tablet A shows no widget subscribing to `dock`; tablet B does.
    expect((await remote(port, { path: '/api/apps/installed', headers: cookie(tokenA) })).status).toBe(403)
    expect((await remote(port, { path: '/api/apps/installed', headers: cookie(tokenNone) })).status).toBe(403)
    expect((await remote(port, { path: '/api/apps/installed', headers: cookie(tokenB) })).status).not.toBe(403)
  })

  it('resolves a command only against the instances of its own screen', async () => {
    const opened = await upgrade(port, { ...cookie(tokenA), origin: `https://127.0.0.1:${port}` })
    if (!('socket' in opened)) throw new Error(`no upgrade: ${opened.status}`)
    const ws = new TinyWs(opened.socket, opened.head)
    try {
      const probe = async (id: string, instanceId: string) => {
        ws.send({ type: 'command', id, channel: 'service-status', name: 'probe', payload: { instanceId } })
        return ws.next((m) => m.id === id)
      }
      const unknown = (await probe('1', 'status-edge')).result
      expect(unknown.ok).toBe(false)
      expect((await probe('2', 'status-b')).result).toEqual(unknown)
      const own = (await probe('3', 'status-a')).result
      // Its own instance is found: whatever it answers, it is not "unknown instance".
      expect(own).not.toEqual(unknown)
    } finally {
      ws.close()
    }
  })
})
