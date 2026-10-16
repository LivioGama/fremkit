import { describe, expect, it } from 'vitest'
import { compactOf, deviceGrid, pickScreen, screensShowing, tileOf } from '../src/shared/screens'
import {
  navCellsUsed, navHasRoom, navItemsIn, navItemsOf,
  type Config, type Screen, type WidgetManifest,
} from '../src/shared/types'

const manifest = (id: string, compact?: { width: number }, settingsSchema: WidgetManifest['settingsSchema'] = {}): WidgetManifest => ({
  id, name: id, version: '1.0.0', sdk: 1, description: '', icon: 'clock',
  minSize: [4, 2], defaultSize: [8, 4], compact,
  subscriptions: [], commands: [], settingsSchema, permissions: { network: [] },
})

function screen(id: string, kind: Screen['kind'], extra: Partial<Screen> = {}): Screen {
  return {
    id, name: id, kind,
    display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
    nav: [],
    pages: [{ id: 'home', name: 'Home', items: [] }],
    ...extra,
  }
}

function config(screens: Screen[], widgets: Config['widgets'] = {}): Config {
  return {
    version: 4,
    theme: 'fremkit',
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets,
    screens,
  }
}

describe('pickScreen', () => {
  const cfg = config([screen('ipad', 'device'), screen('edge', 'edge'), screen('edge-2', 'edge')])

  it('returns the screen with that id', () => {
    expect(pickScreen(cfg, 'ipad').id).toBe('ipad')
    expect(pickScreen(cfg, 'edge-2').id).toBe('edge-2')
  })

  it('falls back to the first edge screen for an unknown or absent id', () => {
    expect(pickScreen(cfg, 'gone').id).toBe('edge')
    expect(pickScreen(cfg, null).id).toBe('edge')
  })

  it('falls back to the first screen when there is no edge screen', () => {
    const devices = config([screen('phone', 'device'), screen('ipad', 'device')])
    expect(pickScreen(devices, 'gone').id).toBe('phone')
  })
})

describe('deviceGrid', () => {
  it('fills a 13-inch iPad in landscape with 40 px cells under an 80 px bar', () => {
    expect(deviceGrid(1376, 1032, 80)).toEqual({ cols: 34, rows: 23 })
  })

  it('fills the same iPad in portrait', () => {
    expect(deviceGrid(1032, 1376, 80)).toEqual({ cols: 25, rows: 32 })
  })

  it('gives the rows the bar no longer takes when it is 40 px tall', () => {
    expect(deviceGrid(1376, 1032, 40)).toEqual({ cols: 34, rows: 24 })
  })
})

describe('tileOf', () => {
  it('joins the shared widget with its placement on one screen', () => {
    const cfg = config([screen('edge', 'edge')], {
      'clock-1': { widgetId: 'clock', title: 'Paris', showTitle: false, opacity: 0.5, settings: { tz: 'Europe/Paris' } },
    })
    expect(tileOf(cfg, { instanceId: 'clock-1', x: 2, y: 3, w: 8, h: 4 })).toEqual({
      instanceId: 'clock-1', widgetId: 'clock', title: 'Paris', showTitle: false, opacity: 0.5,
      settings: { tz: 'Europe/Paris' }, x: 2, y: 3, w: 8, h: 4,
    })
  })
})

describe('compactOf', () => {
  it('builds the one-row instance the bar and its popover draw', () => {
    const cfg = config([screen('edge', 'edge')], {
      'weather-1': { widgetId: 'weather', showTitle: true, accentColor: '#112233', settings: { city: 'Example' } },
    })
    const inst = compactOf(cfg, { instanceId: 'weather-1', slot: 'right' }, 6)
    expect(inst).toMatchObject({ instanceId: 'weather-1', widgetId: 'weather', x: 0, y: 0, w: 6, h: 1, settings: { city: 'Example' } })
  })
})

describe('screensShowing', () => {
  it('lists every screen that places the widget, on a page or in its bar', () => {
    const cfg = config([
      screen('edge', 'edge', { pages: [{ id: 'home', name: 'Home', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 }] }] }),
      screen('ipad', 'device', { nav: [{ instanceId: 'clock-1', slot: 'left' }] }),
      screen('phone', 'device'),
    ], { 'clock-1': { widgetId: 'clock', showTitle: true, settings: {} } })
    expect(screensShowing(cfg, 'clock-1').map((s) => s.id)).toEqual(['edge', 'ipad'])
    expect(screensShowing(cfg, 'nobody')).toEqual([])
  })
})

describe('bar helpers per screen', () => {
  const manifests = {
    clock: manifest('clock', { width: 5 }, { compactDate: { type: 'boolean', label: 'Date', default: false } }),
    weather: manifest('weather', { width: 4 }, { compactCities: { type: 'boolean', label: 'Cities', default: true } }),
  }
  const widgets: Config['widgets'] = {
    'clock-1': { widgetId: 'clock', showTitle: true, settings: {} },
    'weather-1': { widgetId: 'weather', showTitle: true, settings: {} },
  }
  const wide = screen('edge', 'edge', { nav: [{ instanceId: 'clock-1', slot: 'left' }, { instanceId: 'weather-1', slot: 'right' }] })
  const narrow = screen('ipad', 'device', {
    display: { cols: 25, rows: 32, cell: 40, autoCycleSeconds: 0 },
    nav: [{ instanceId: 'clock-1', slot: 'left' }, { instanceId: 'weather-1', slot: 'left' }],
  })

  it('reads the items of one screen, and of one cluster', () => {
    expect(navItemsOf(wide).map((i) => i.instanceId)).toEqual(['clock-1', 'weather-1'])
    expect(navItemsIn(wide, 'right').map((i) => i.instanceId)).toEqual(['weather-1'])
    expect(navItemsIn(narrow, 'right')).toEqual([])
  })

  it('counts cells with the manifest defaults merged in, and a missing widget as 0', () => {
    // clock: 5; weather: its default compactCities widens it to 8.
    expect(navCellsUsed(wide, widgets, manifests)).toBe(13)
    const orphan = screen('x', 'device', { nav: [{ instanceId: 'gone', slot: 'left' }] })
    expect(navCellsUsed(orphan, widgets, manifests)).toBe(0)
  })

  it('measures room against that screen\'s cols minus the dots', () => {
    // 64 − 10 = 54 on the Edge; 25 − 10 = 15 on the iPad, which holds 13.
    expect(navHasRoom(wide, widgets, manifests, 41)).toBe(true)
    expect(navHasRoom(wide, widgets, manifests, 42)).toBe(false)
    expect(navHasRoom(narrow, widgets, manifests, 2)).toBe(true)
    expect(navHasRoom(narrow, widgets, manifests, 3)).toBe(false)
  })
})
