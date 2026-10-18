import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { BrightnessSettingsSchema, ConfigSchema, type BrightnessSettings, type Config } from '../src/config/schema.js'
import { phaseAt, sunEvents, transitionsAround } from '../src/brightness/schedule.js'
import { decide, FOLLOW_RELEASE, followLevel, type Held } from '../src/brightness/decide.js'
import { BrightnessService, HELPER_STALE_MS, HelperReportSchema } from '../src/brightness/service.js'
import { createBrightnessProvider, mayCommandBrightness } from '../src/brightness/provider.js'
import { buildApp } from '../src/app.js'

const MIN = 60_000
const settings = (patch: { dayNight?: object; followMac?: object } = {}): BrightnessSettings =>
  BrightnessSettingsSchema.parse({ dayNight: patch.dayNight ?? {}, followMac: patch.followMac ?? {} })
/** A local wall-clock instant, so the fixed-time tests hold in any time zone. */
const local = (h: number, m = 0, day = 18): number => new Date(2026, 9, day, h, m).getTime()
const julianDay = (ms: number): number => Math.round(ms / 86_400_000 + 2440587.5 - 2451545)
const hhmmUtc = (ms: number): string => new Date(ms).toISOString().slice(11, 16)
const minutesApart = (a: string, b: string): number => {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
  return Math.abs(m(a) - m(b))
}

describe('sun times', () => {
  it('matches published sunrise and sunset in Paris at the June solstice within a few minutes', () => {
    const ev = sunEvents(julianDay(Date.UTC(2026, 5, 21, 12)), 48.8566, 2.3522)
    if (typeof ev === 'string') throw new Error('expected a sunrise and a sunset')
    // Published: 05:47 and 21:58 CEST, i.e. 03:47 and 19:58 UTC.
    expect(minutesApart(hhmmUtc(ev.rise), '03:47')).toBeLessThanOrEqual(3)
    expect(minutesApart(hhmmUtc(ev.set), '19:58')).toBeLessThanOrEqual(3)
  })
  it('reports the polar day and the polar night', () => {
    expect(sunEvents(julianDay(Date.UTC(2026, 5, 21, 12)), 69.65, 18.96)).toBe('day')
    expect(sunEvents(julianDay(Date.UTC(2026, 11, 21, 12)), 69.65, 18.96)).toBe('night')
  })
  it('needs coordinates for the sun schedule', () => {
    expect(transitionsAround(local(12), settings({ dayNight: { enabled: true } }).dayNight)).toBe('no-location')
  })
})

describe('day/night phase', () => {
  const fixed = settings({ dayNight: { enabled: true, schedule: 'fixed', dayAt: '07:00', nightAt: '21:00', rampMinutes: 20 } }).dayNight
  it('is day between the two times and night outside them', () => {
    expect(phaseAt(local(12), fixed)).toMatchObject({ night: 0, state: 'day' })
    expect(phaseAt(local(23), fixed)).toMatchObject({ night: 1, state: 'night' })
    expect(phaseAt(local(3), fixed)).toMatchObject({ night: 1, state: 'night' })
  })
  it('ramps from the transition on, over rampMinutes', () => {
    const halfway = phaseAt(local(21, 10), fixed)
    if (halfway === 'no-location') throw new Error()
    expect(halfway.state).toBe('dimming')
    expect(halfway.night).toBeCloseTo(0.5)
    const morning = phaseAt(local(7, 5), fixed)
    if (morning === 'no-location') throw new Error()
    expect(morning.state).toBe('brightening')
    expect(morning.night).toBeCloseTo(0.75)
  })
  it('names the next transition', () => {
    const p = phaseAt(local(12), fixed)
    if (p === 'no-location') throw new Error()
    expect(p.next).toEqual({ at: local(21), to: 'night' })
  })
  it('switches at once with no ramp', () => {
    const noRamp = { ...fixed, rampMinutes: 0 }
    expect(phaseAt(local(21), noRamp)).toMatchObject({ night: 1, state: 'night' })
  })
})

describe('decide', () => {
  const dn = { enabled: true, schedule: 'fixed', day: 80, night: 20, rampMinutes: 20 }
  const fm = { enabled: true, scale: 1, offset: 0 }
  const held = (h: Partial<Held>): Held => ({ value: 55, at: local(12), mode: 'day-night', builtin: null, ...h })

  it('leaves the screen alone when nothing is on and nobody touched it', () => {
    expect(decide({ settings: undefined, now: local(12), builtin: 0.5, held: null })).toMatchObject({ target: null, mode: 'manual' })
  })
  it('keeps a manual level with no mode on', () => {
    expect(decide({ settings: settings(), now: local(12), builtin: null, held: held({ mode: 'manual' }) }))
      .toMatchObject({ target: 55, mode: 'manual', overridden: false })
  })
  it('follows the schedule, ramp included', () => {
    const s = settings({ dayNight: dn })
    expect(decide({ settings: s, now: local(12), builtin: null, held: null })).toMatchObject({ target: 80, mode: 'day-night' })
    expect(decide({ settings: s, now: local(21, 10), builtin: null, held: null }).target).toBe(50)
    expect(decide({ settings: s, now: local(23), builtin: null, held: null }).target).toBe(20)
  })
  it('maps the built-in display with scale and offset, clamped', () => {
    expect(followLevel(0.5, { enabled: true, scale: 1, offset: 0 })).toBe(50)
    expect(followLevel(0.5, { enabled: true, scale: 1.5, offset: 10 })).toBe(85)
    expect(followLevel(0.9, { enabled: true, scale: 2, offset: 0 })).toBe(100)
    expect(followLevel(0.1, { enabled: true, scale: 1, offset: -30 })).toBe(0)
  })
  it('follows the Mac, and says so when there is no built-in display', () => {
    const s = settings({ followMac: fm })
    expect(decide({ settings: s, now: local(12), builtin: 0.62, held: null })).toMatchObject({ target: 62, mode: 'follow-mac' })
    expect(decide({ settings: s, now: local(12), builtin: null, held: null })).toMatchObject({ target: null, mode: 'manual', followProblem: 'no-builtin' })
  })
  it('with both on, follows the Mac under a night ceiling that ramps down', () => {
    const s = settings({ dayNight: dn, followMac: fm })
    expect(decide({ settings: s, now: local(12), builtin: 0.9, held: null })).toMatchObject({ target: 90, mode: 'both' })
    expect(decide({ settings: s, now: local(23), builtin: 0.9, held: null }).target).toBe(20)
    expect(decide({ settings: s, now: local(23), builtin: 0.1, held: null }).target).toBe(10)
    // Halfway down the ramp the ceiling is halfway between 100 and 20.
    expect(decide({ settings: s, now: local(21, 10), builtin: 0.9, held: null }).target).toBe(60)
  })
  it('lets a manual change hold day/night until the next transition starts', () => {
    const s = settings({ dayNight: dn })
    const h = held({ at: local(12), mode: 'day-night' })
    expect(decide({ settings: s, now: local(20, 59), builtin: null, held: h })).toMatchObject({ target: 55, overridden: true, releaseHeld: false })
    expect(decide({ settings: s, now: local(21, 1), builtin: null, held: h })).toMatchObject({ overridden: false, releaseHeld: true })
  })
  it('lets a manual change hold follow-the-Mac until the built-in display moves noticeably', () => {
    const s = settings({ followMac: fm })
    const h = held({ mode: 'follow-mac', builtin: 0.5 })
    expect(decide({ settings: s, now: local(13), builtin: 0.55, held: h })).toMatchObject({ target: 55, overridden: true })
    expect(decide({ settings: s, now: local(13), builtin: 0.5 + FOLLOW_RELEASE, held: h })).toMatchObject({ target: 60, releaseHeld: true })
  })
  it('never lets a level chosen with no mode on override a mode turned on later', () => {
    const s = settings({ dayNight: dn })
    expect(decide({ settings: s, now: local(12), builtin: null, held: held({ mode: 'manual', value: 5 }) }))
      .toMatchObject({ target: 80, overridden: false, releaseHeld: true })
  })
  it('reports day/night without coordinates as a problem, not a mode', () => {
    expect(decide({ settings: settings({ dayNight: { enabled: true } }), now: local(12), builtin: null, held: null }))
      .toMatchObject({ mode: 'manual', dayNightProblem: 'no-location' })
  })
})

function config(screens: object[] = [{}]): Config {
  return ConfigSchema.parse({
    version: 4,
    screens: screens.map((s, i) => ({ id: i === 0 ? 'edge' : `s${i}`, name: 'S', kind: 'edge', pages: [{ id: 'p', name: 'P' }], ...s })),
  })
}
const report = (r: object = {}) => HelperReportSchema.parse({ available: true, value: 70, builtin: 0.4, display: 'XENEON EDGE', ...r })

describe('BrightnessService', () => {
  let now: number
  let cfg: Config
  let svc: BrightnessService
  beforeEach(() => {
    now = local(12)
    cfg = config()
    svc = new BrightnessService({ config: () => cfg, now: () => now })
  })

  it('says the kiosk screen is unreachable until the helper reports, and again once it goes quiet', () => {
    expect(svc.snapshot().screens.edge).toMatchObject({ available: false, reason: 'no-helper', value: null })
    svc.helperReport(report())
    expect(svc.snapshot().screens.edge).toMatchObject({ available: true, value: 70, target: null, builtin: true, display: 'XENEON EDGE' })
    now += HELPER_STALE_MS
    expect(svc.snapshot().screens.edge).toMatchObject({ available: false, reason: 'no-helper' })
  })
  it('passes on why the display cannot be driven', () => {
    svc.helperReport(report({ available: false, reason: 'no-ddc', value: null }))
    expect(svc.snapshot().screens.edge).toMatchObject({ available: false, reason: 'no-ddc' })
    expect(() => svc.set(undefined, 50)).toThrow('unavailable')
  })
  it('marks a device screen unsupported and a second Edge screen without a helper', () => {
    cfg = config([{}, { kind: 'device' }, {}])
    svc.helperReport(report())
    const s = svc.snapshot().screens
    expect(s.s1).toMatchObject({ available: false, reason: 'device-unsupported' })
    expect(s.s2).toMatchObject({ available: false, reason: 'no-helper' })
    expect(() => svc.set('s1', 50)).toThrow('unavailable')
    expect(() => svc.set('nope', 50)).toThrow('unknown-screen')
  })
  it('drives the screen the kiosk names, when it names an Edge screen', () => {
    cfg = config([{}, {}])
    svc.helperReport(report({ screen: 's1' }))
    expect(svc.snapshot().kiosk).toBe('s1')
    svc.helperReport(report({ screen: 'missing' }))
    expect(svc.snapshot().kiosk).toBe('edge')
  })
  it('sets a level, bumping seq even for the same value, and shows it until the helper reads back', () => {
    svc.helperReport(report())
    expect(svc.set(undefined, 49.6)).toEqual({ screen: 'edge', value: 50 })
    const a = svc.snapshot().screens.edge
    expect(a).toMatchObject({ target: 50, value: 50, seq: 1 })
    svc.helperReport(report({ value: 70 }))
    expect(svc.snapshot().screens.edge.value).toBe(50)
    svc.helperReport(report({ value: 51, applied: 1 }))
    expect(svc.snapshot().screens.edge.value).toBe(51)
    svc.set(undefined, 50)
    expect(svc.snapshot().screens.edge).toMatchObject({ target: 50, seq: 2 })
  })
  it('steps from the level the screen is at, clamped', () => {
    svc.helperReport(report({ value: 95 }))
    expect(svc.step(undefined, 10).value).toBe(100)
    expect(svc.step(undefined, -30).value).toBe(70)
  })
  it('runs the schedule on each snapshot, holds a manual change, and resumes on request', () => {
    cfg = config([{ brightness: { dayNight: { enabled: true, schedule: 'fixed', day: 80, night: 20 } } }])
    svc.helperReport(report())
    expect(svc.snapshot().screens.edge).toMatchObject({ target: 80, mode: 'day-night', seq: 1, phase: { state: 'day' } })
    svc.set(undefined, 40)
    expect(svc.snapshot().screens.edge).toMatchObject({ target: 40, overridden: true })
    svc.resume(undefined)
    expect(svc.snapshot().screens.edge).toMatchObject({ target: 80, overridden: false })
    now = local(23)
    svc.helperReport(report())
    expect(svc.snapshot().screens.edge).toMatchObject({ target: 20, phase: { state: 'night' } })
  })
  it('follows the built-in display the helper reports', () => {
    cfg = config([{ brightness: { followMac: { enabled: true, offset: 10 } } }])
    svc.helperReport(report({ builtin: 0.3 }))
    expect(svc.snapshot().screens.edge).toMatchObject({ target: 40, mode: 'follow-mac' })
    svc.helperReport(report({ builtin: null }))
    expect(svc.snapshot().screens.edge).toMatchObject({ mode: 'manual', followProblem: 'no-builtin', builtin: false })
  })
})

describe('brightness provider', () => {
  const local = { loopback: true, paired: false }
  it('validates command payloads and refreshes after each', async () => {
    let refreshed = 0
    const cfg = config()
    const svc = new BrightnessService({ config: () => cfg })
    svc.helperReport(report())
    const p = createBrightnessProvider(svc, () => refreshed++)
    await expect(p.commands!.set({ value: 'bright' }, local)).rejects.toThrow()
    await expect(p.commands!.set({ value: 30, screen: 'Not A Slug' }, local)).rejects.toThrow()
    await expect(p.commands!.step({ delta: 500 }, local)).rejects.toThrow()
    expect(refreshed).toBe(0)
    await expect(p.commands!.set({ value: 30, instanceId: 'brightness-1' }, local)).resolves.toEqual({ screen: 'edge', value: 30 })
    await expect(p.commands!.resume({}, local)).resolves.toEqual({ screen: 'edge' })
    expect(refreshed).toBe(2)
  })
  it('turns service errors into readable messages', async () => {
    const cfg = config()
    const p = createBrightnessProvider(new BrightnessService({ config: () => cfg }))
    await expect(p.commands!.set({ value: 30 }, local)).rejects.toThrow(/luminosité|brightness/)
  })
  it('refuses every command from a client that is not on this Mac, or that says nothing', async () => {
    const cfg = config([{}, { kind: 'device' }])
    const svc = new BrightnessService({ config: () => cfg })
    svc.helperReport(report())
    const p = createBrightnessProvider(svc)
    for (const ctx of [undefined, { loopback: false, paired: false }]) {
      await expect(p.commands!.set({ value: 30 }, ctx)).rejects.toThrow(/machine/)
      await expect(p.commands!.step({ delta: 10 }, ctx)).rejects.toThrow(/machine/)
      await expect(p.commands!.resume({}, ctx)).rejects.toThrow(/machine/)
    }
    expect(svc.snapshot().screens.edge.target).toBeNull()
  })
  it('mayCommandBrightness: this Mac drives any screen, a remote client none', () => {
    const [edge, device] = config([{}, { kind: 'device' }]).screens
    expect(mayCommandBrightness({ loopback: true, paired: false }, edge)).toBe(true)
    expect(mayCommandBrightness({ loopback: true, paired: false }, device)).toBe(true)
    expect(mayCommandBrightness({ loopback: false, paired: false }, edge)).toBe(false)
    expect(mayCommandBrightness({ loopback: false, paired: false }, device)).toBe(false)
    expect(mayCommandBrightness(undefined, edge)).toBe(false)
  })
})

describe('POST /api/hooks/brightness', () => {
  let dataDir: string
  let app: FastifyInstance
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'fremkit-brightness-'))
    await writeFile(join(dataDir, 'fremkit.json'), JSON.stringify(config()), 'utf8')
    app = await buildApp({ accessToken: null, dataDir, widgetsDir: join(process.cwd(), '..', 'widgets'), providers: [], connectionTypes: [] })
  })
  afterEach(async () => { await app.close() })

  it('takes a report from this machine', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/hooks/brightness', payload: { available: true, value: 64, builtin: 0.5 } })
    expect(res.statusCode).toBe(204)
  })
  it('refuses a malformed report and a remote one', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/hooks/brightness', payload: { available: 'yes' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/hooks/brightness', payload: { available: true, value: 101 } })).statusCode).toBe(400)
    const remote = await app.inject({ method: 'POST', url: '/api/hooks/brightness', payload: { available: true }, remoteAddress: '203.0.113.7' })
    expect(remote.statusCode).toBe(403)
  })
})
