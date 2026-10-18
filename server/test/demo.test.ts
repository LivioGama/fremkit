import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'

/**
 * Demo mode must never construct a real provider: each of them is replaced by a spy that throws,
 * so building a demo app proves none is called, and building a normal one proves the spies are
 * wired (it fails).
 */
const boom = (name: string) => vi.fn(() => { throw new Error(`real provider constructed in demo mode: ${name}`) })
const spies = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>))
function spy(name: string): ReturnType<typeof vi.fn> {
  spies[name] ??= boom(name)
  return spies[name]
}
vi.mock('../src/providers/system.js', async (orig) => ({ ...(await orig<object>()), createSystemProvider: spy('system') }))
vi.mock('../src/claude/providers.js', async (orig) => ({
  ...(await orig<object>()),
  createClaudeSessionsProvider: spy('claude-sessions'),
  createClaudeUsageProvider: spy('claude-usage'),
  createClaudeAccountProvider: spy('claude-account'),
}))
vi.mock('../src/claude/identity.js', async (orig) => ({ ...(await orig<object>()), createClaudeIdentityProvider: spy('claude-identity') }))
vi.mock('../src/providers/codex.js', async (orig) => ({ ...(await orig<object>()), createCodexProvider: spy('codex') }))
vi.mock('../src/dock/provider.js', async (orig) => ({ ...(await orig<object>()), createDockProvider: spy('dock') }))
vi.mock('../src/providers/disk-map.js', async (orig) => ({ ...(await orig<object>()), createDiskMapProvider: spy('disk-map') }))
vi.mock('../src/providers/shortcuts.js', async (orig) => ({ ...(await orig<object>()), createShortcutsProvider: spy('shortcuts') }))
vi.mock('../src/providers/service-status.js', async (orig) => ({ ...(await orig<object>()), createServiceStatusProvider: spy('service-status') }))
vi.mock('../src/brightness/provider.js', async (orig) => ({ ...(await orig<object>()), createBrightnessProvider: spy('brightness') }))
vi.mock('../src/providers/calendar.js', async (orig) => ({ ...(await orig<object>()), createCalendarProvider: spy('calendar') }))
vi.mock('../src/apps/icons.js', async (orig) => ({ ...(await orig<object>()), AppIcons: spy('app-icons') }))
vi.mock('../src/secrets/keychain.js', async (orig) => ({ ...(await orig<object>()), KeychainSecretStore: spy('keychain') }))

const { buildApp } = await import('../src/app.js')
const { createDemoProviders } = await import('../src/demo/providers.js')
const { demoConfig, prepareDemoDataDir, DEMO_MARKER, DemoDataDirError } = await import('../src/demo/seed.js')
const { demoPublicFetch } = await import('../src/demo/fetch.js')
const { ConfigSchema } = await import('../src/config/schema.js')
const { errorCode } = await import('../src/providers/registry.js')

const WIDGETS = resolve(import.meta.dirname, '..', '..', 'widgets')
let dir: string
let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function demoApp(): Promise<FastifyInstance> {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-demo-test-'))
  const { dir: dataDir } = await prepareDemoDataDir({ configured: join(dir, 'data'), liveDataDir: join(dir, 'live') })
  return buildApp({ accessToken: null, dataDir, widgetsDir: WIDGETS, demo: true, devicesPort: 0 })
}

/**
 * The built-in widgets' folders. Not a bare readdir: the Finder drops a `.DS_Store` into any
 * folder a person opens, and the main checkout is one.
 */
async function widgetFolders(readdir: typeof import('node:fs/promises').readdir): Promise<string[]> {
  const entries = await readdir(WIDGETS, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
}

describe('demo mode', () => {
  it('builds without constructing a single real provider', async () => {
    app = await demoApp()
    for (const [name, fn] of Object.entries(spies)) expect(fn, name).not.toHaveBeenCalled()
    expect((await app.inject({ url: '/api/demo' })).json()).toEqual({ demo: true })
  })

  it('the spies are live: a normal build trips them', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-demo-test-'))
    await expect(buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: WIDGETS, devicesPort: 0 })).rejects.toThrow(/real provider constructed/)
  })

  it('answers the weather widget through the proxy without the network', async () => {
    app = await demoApp()
    const geo = await app.inject({ url: '/api/proxy/weather?url=' + encodeURIComponent('https://geocoding-api.open-meteo.com/v1/search?name=paris&count=1') })
    expect(geo.statusCode).toBe(200)
    expect(geo.json().results[0].name).toBe('Paris')
    const forecast = await app.inject({ url: '/api/proxy/weather?url=' + encodeURIComponent('https://api.open-meteo.com/v1/forecast?latitude=1&longitude=2') })
    expect(forecast.statusCode).toBe(200)
    expect(typeof forecast.json().current.temperature_2m).toBe('number')
  })

  it('keeps every other host off the wire', async () => {
    const res = await demoPublicFetch()('https://example.com/anything')
    expect(res.status).toBe(503)
  })

  it('publishes on every channel a built-in widget subscribes to, without an error', async () => {
    const config = ConfigSchema.parse(demoConfig())
    const providers = createDemoProviders({ config: () => config })
    const channels = new Set(providers.map((p) => p.channel))
    const { readdir } = await import('node:fs/promises')
    for (const id of await widgetFolders(readdir)) {
      const manifest = JSON.parse(await readFile(join(WIDGETS, id, 'manifest.json'), 'utf8')) as { subscriptions?: string[]; commands?: string[] }
      for (const channel of [...(manifest.subscriptions ?? []), ...(manifest.commands ?? [])]) {
        // `calendar:*` is the calendar connections', answered by the demo connection types.
        if (channel.endsWith(':*')) continue
        expect(channels, `${id} → ${channel}`).toContain(channel)
      }
    }
    for (const p of providers) {
      if (!p.poll) continue
      const data = await p.poll()
      // The few channels of registry widgets the demo does not act out say so with a code.
      if (!['codex', 'codex-live', 'local-models'].includes(p.channel)) expect(errorCode(data, false), p.channel).toBeNull()
    }
  })

  it('acts commands out on the fake state', async () => {
    const config = ConfigSchema.parse(demoConfig())
    const providers = createDemoProviders({ config: () => config })
    const spotify = providers.find((p) => p.channel === 'spotify')!
    expect(((await spotify.poll!()) as { state: string }).state).toBe('playing')
    await spotify.commands!.playPause({})
    expect(((await spotify.poll!()) as { state: string }).state).toBe('paused')
    const volume = providers.find((p) => p.channel === 'volume')!
    await volume.commands!.set({ level: 12 })
    expect(((await volume.poll!()) as { level: number }).level).toBe(12)
    const status = providers.find((p) => p.channel === 'service-status')!
    const probe = await status.commands!.probe({ instanceId: 'service-status-1' }) as { ok: boolean; results: unknown[] }
    expect(probe.ok).toBe(true)
    expect(probe.results).toHaveLength(4)
  })

  it('seeds a dashboard the config schema accepts, with every built-in on it', async () => {
    const config = ConfigSchema.parse(demoConfig())
    const { readdir } = await import('node:fs/promises')
    const shown = new Set(Object.values(config.widgets).map((w) => w.widgetId))
    for (const id of await widgetFolders(readdir)) expect(shown, id).toContain(id)
    expect(config.secrets.backend).toBe('file')
  })
})

describe('the demo data folder', () => {
  it('is temporary unless named, and carries the marker', async () => {
    const prepared = await prepareDemoDataDir({ liveDataDir: '/nonexistent' })
    try {
      expect(prepared.temporary).toBe(true)
      expect(existsSync(join(prepared.dir, DEMO_MARKER))).toBe(true)
      expect(existsSync(join(prepared.dir, 'fremkit.json'))).toBe(true)
      // The calendars' required address, so the editor does not list them as broken.
      expect(Object.keys(JSON.parse(await readFile(join(prepared.dir, 'secrets.json'), 'utf8')))).toContain('demo-work/url')
    } finally {
      await rm(prepared.dir, { recursive: true, force: true })
    }
  })

  it('refuses the live folder, and a folder holding a real dashboard', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-demo-test-'))
    await expect(prepareDemoDataDir({ configured: join(dir, 'live'), liveDataDir: join(dir, 'live') })).rejects.toBeInstanceOf(DemoDataDirError)
    await mkdir(join(dir, 'real'))
    await writeFile(join(dir, 'real', 'fremkit.json'), '{}')
    await expect(prepareDemoDataDir({ configured: join(dir, 'real'), liveDataDir: join(dir, 'live') })).rejects.toBeInstanceOf(DemoDataDirError)
    expect(await readFile(join(dir, 'real', 'fremkit.json'), 'utf8')).toBe('{}')
  })

  it('reuses a demo folder as it was left', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-demo-test-'))
    const first = await prepareDemoDataDir({ configured: join(dir, 'd'), liveDataDir: join(dir, 'live') })
    await writeFile(join(first.dir, 'fremkit.json'), '{"edited":true}')
    await prepareDemoDataDir({ configured: join(dir, 'd'), liveDataDir: join(dir, 'live') })
    expect(await readFile(join(first.dir, 'fremkit.json'), 'utf8')).toBe('{"edited":true}')
  })
})
