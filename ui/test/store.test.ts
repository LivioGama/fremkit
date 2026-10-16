import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAdminStore, freeInstanceId, SAVE_DEBOUNCE_MS, UNDO_LIMIT, type StoreDeps } from '../src/admin/store'
import type { Config, Placement, Widget, WidgetManifest, WidgetsResponse } from '../src/shared/types'

/** A promise this test controls: resolve()/reject() it whenever the scenario needs the "server" to answer. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Flush pending microtask chains (promise resolutions triggered outside of fake-timer ticks). */
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

const clockManifest: WidgetManifest = {
  id: 'clock', name: 'Horloge', version: '1.0.0', sdk: 1, description: '', icon: 'clock',
  minSize: [8, 4], defaultSize: [16, 4], subscriptions: [], commands: [],
  settingsSchema: {}, permissions: { network: [] },
}

function config(): Config {
  return {
    version: 4,
    connections: [],
    secrets: { backend: 'file' },
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: { 'clock-1': { widgetId: 'clock', showTitle: true, settings: {} } },
    screens: [{
      id: 'edge', name: 'Xeneon Edge', kind: 'edge',
      display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
      nav: [],
      pages: [{ id: 'home', name: 'Accueil', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }] }],
    }],
  }
}

/**
 * The Edge plus a 13-inch iPad in landscape (34 × 23 under an 80 px bar). `clock-1` is on both,
 * smaller on the iPad; `cpu-1` is on the iPad only.
 */
function twoScreens(): Config {
  const cfg = config()
  cfg.widgets['cpu-1'] = { widgetId: 'cpu', showTitle: true, settings: {} }
  cfg.screens.push({
    id: 'ipad', name: 'iPad', kind: 'device',
    display: { cols: 34, rows: 23, cell: 40, autoCycleSeconds: 0, orientation: 'landscape', viewport: { width: 1376, height: 1032 } },
    nav: [],
    pages: [{ id: 'main', name: 'Main', items: [
      { instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 },
      { instanceId: 'cpu-1', x: 8, y: 0, w: 8, h: 4 },
    ] }],
  })
  return cfg
}

/** The bar only takes widgets whose manifest declares a compact rendering. */
const compactClock: WidgetManifest = { ...clockManifest, compact: { width: 5 } }
const barWidgets: WidgetsResponse = {
  widgets: { clock: compactClock, cpu: { ...compactClock, id: 'cpu' }, plain: clockManifest },
  errors: [], sources: {}, asks: {}, sdk: 1,
}

function make(apiOverrides: Partial<StoreDeps['api']> = {}) {
  const api: StoreDeps['api'] = {
    getConfig: vi.fn(async () => config()),
    getStatus: vi.fn(async () => ({ degraded: false })),
    getWidgets: vi.fn(async (): Promise<WidgetsResponse> => ({ widgets: { clock: clockManifest }, errors: [], sources: {}, asks: {}, sdk: 1 })),
    putConfig: vi.fn(async (c: Config) => c),
    rescan: vi.fn(async (): Promise<WidgetsResponse> => ({ widgets: { clock: clockManifest }, errors: [], sources: {}, asks: {}, sdk: 1 })),
    ...apiOverrides,
  }
  let push: ((c: Config) => void) | null = null
  const store = createAdminStore({ api, subscribeConfig: (cb) => { push = cb; return () => { push = null } } })
  return { store, api, emit: (c: Config) => push?.(c) }
}
type Store = ReturnType<typeof make>['store']

const cpuManifest: WidgetManifest = { ...clockManifest, id: 'cpu', name: 'CPU' }
function makeTwoScreens(mutate: (c: Config) => void = () => {}) {
  return make({
    getConfig: vi.fn(async () => { const c = twoScreens(); mutate(c); return c }),
    getWidgets: vi.fn(async (): Promise<WidgetsResponse> => ({ widgets: { clock: clockManifest, cpu: cpuManifest }, errors: [], sources: {}, asks: {}, sdk: 1 })),
  })
}

/** The placements of one page of one screen, as stored. */
const items = (store: Store, screen = 0, page = 0): Placement[] => store.state.config!.screens[screen].pages[page].items
const widgetsOf = (store: Store): Record<string, Widget> => store.state.config!.widgets

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('saving', () => {
  it('groups several mutations into a single PUT after the debounce', async () => {
    const { store, api } = make()
    await store.load()
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 4 })
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 8 })
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 12 })
    expect(store.state.status).toBe('saving')
    expect(api.putConfig).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(api.putConfig).toHaveBeenCalledTimes(1)
    expect((api.putConfig as ReturnType<typeof vi.fn>).mock.calls[0][0].screens[0].pages[0].items[0].x).toBe(12)
    expect(store.state.status).toBe('saved')
  })

  it('flush sends the pending change immediately', async () => {
    const { store, api } = make()
    await store.load()
    store.apply((c) => { c.screens[0].pages[0].name = 'Deux' })
    await store.flush()
    expect(api.putConfig).toHaveBeenCalledTimes(1)
    expect(store.state.status).toBe('saved')
  })
})

describe('single-flight', () => {
  it('a mutation that arrives while a PUT is in flight is sent once more, with the latest config, once it settles', async () => {
    const first = deferred<Config>()
    let calls = 0
    const putConfig = vi.fn(async (c: Config) => { calls++; return calls === 1 ? first.promise : c })
    const { store, api } = make({ putConfig })
    await store.load()

    store.apply((c) => { c.screens[0].pages[0].items[0].x = 4 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(api.putConfig).toHaveBeenCalledTimes(1) // first PUT started, still unresolved

    store.apply((c) => { c.screens[0].pages[0].items[0].x = 8 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    // the debounce for the newer edit elapsed, but the first PUT is still in flight:
    // no second, concurrent PUT may start yet
    expect(api.putConfig).toHaveBeenCalledTimes(1)

    first.resolve(config())
    await tick()
    expect(api.putConfig).toHaveBeenCalledTimes(2)
    expect((api.putConfig as ReturnType<typeof vi.fn>).mock.calls[1][0].screens[0].pages[0].items[0].x).toBe(8)
    await tick()
    expect(store.state.status).toBe('saved')
  })

  it('an older PUT that fails after a newer edit does not reload over it, and retries with the latest config', async () => {
    const first = deferred<Config>()
    const second = deferred<Config>()
    let calls = 0
    const putConfig = vi.fn(async (c: Config) => {
      calls++
      if (calls === 1) return first.promise
      if (calls === 2) return second.promise
      return c
    })
    const getConfig = vi.fn(async () => config())
    const { store, api } = make({ putConfig, getConfig })
    await store.load()
    const getConfigCallsAfterLoad = (api.getConfig as ReturnType<typeof vi.fn>).mock.calls.length

    store.apply((c) => { c.screens[0].pages[0].items[0].x = 4 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 8 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(api.putConfig).toHaveBeenCalledTimes(1)

    first.reject(new Error('conflit'))
    await tick()

    // the newer edit (x=8) must survive: no reload clobbers it
    expect(store.state.config!.screens[0].pages[0].items[0].x).toBe(8)
    expect(store.state.status).toBe('error')
    expect(store.state.toast).toBe('conflit')
    expect((api.getConfig as ReturnType<typeof vi.fn>).mock.calls.length).toBe(getConfigCallsAfterLoad) // no recovery reload
    expect(api.putConfig).toHaveBeenCalledTimes(2) // one retry already in flight, carrying the latest config
    expect((api.putConfig as ReturnType<typeof vi.fn>).mock.calls[1][0].screens[0].pages[0].items[0].x).toBe(8)

    second.resolve(config())
    await tick()
    expect(store.state.status).toBe('saved')
  })

  it('two rapid mutations during a slow PUT coalesce into a single trailing PUT, sent in order', async () => {
    const first = deferred<Config>()
    const order: number[] = []
    let calls = 0
    const putConfig = vi.fn(async (c: Config) => {
      calls++
      order.push(c.screens[0].pages[0].items[0].x)
      return calls === 1 ? first.promise : c
    })
    const { store, api } = make({ putConfig })
    await store.load()

    store.apply((c) => { c.screens[0].pages[0].items[0].x = 4 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 8 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 12 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    // the second PUT only ever starts once the first settles: still just the original call
    expect(api.putConfig).toHaveBeenCalledTimes(1)

    first.resolve(config())
    await tick()
    expect(api.putConfig).toHaveBeenCalledTimes(2)
    expect(order).toEqual([4, 12]) // the intermediate x=8 never went out on its own, and bodies arrived in order
    await tick()
    expect(store.state.status).toBe('saved')
  })

  it('an edit made during the recovery GET is kept, and the GET result is discarded', async () => {
    const fresh = deferred<Config>()
    const getConfig = vi.fn(async () => fresh.promise)
    const putConfig = vi.fn(async () => { throw new Error('boum') })
    const { store } = make({ getConfig, putConfig })
    // load() must resolve before the failing PUT: answer its own getConfig() first.
    fresh.resolve(config())
    await store.load()

    const second = deferred<Config>()
    ;(getConfig as ReturnType<typeof vi.fn>).mockImplementation(async () => second.promise)

    store.apply((c) => { c.screens[0].pages[0].items[0].x = 4 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    await tick()
    // the PUT failed and the recovery GET is in flight; the user keeps editing meanwhile
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 24 })
    second.resolve(config()) // the server still has x = 0
    await tick()

    expect(store.state.config!.screens[0].pages[0].items[0].x).toBe(24)
    expect(store.state.status).toBe('error')
    expect(store.state.toast).toBe('boum')
    // the edit's own debounce still fires, so the pending change is retried
    const before = (putConfig as ReturnType<typeof vi.fn>).mock.calls.length
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    await tick()
    expect((putConfig as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before)
  })
})

describe('degraded server', () => {
  it('raises the banner on load and stops saving', async () => {
    const { store, api } = make({ getStatus: vi.fn(async () => ({ degraded: true })) })
    await store.load()
    expect(store.state.degraded).toBe(true)

    store.apply((c) => { c.screens[0].pages[0].items[0].x = 8 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4)
    expect(api.putConfig).not.toHaveBeenCalled()
    expect(store.state.status).toBe('error')
    expect(store.state.toast).toMatch(/illisible/)
    expect(store.state.config!.screens[0].pages[0].items[0].x).toBe(8) // the local edit is kept
  })

  it('a refused save raises the banner and never reloads over the local config', async () => {
    const putConfig = vi.fn(async () => { throw new Error('configuration sur disque illisible') })
    // Healthy at load time; the file becomes unreadable under the server afterwards.
    let degraded = false
    const getStatus = vi.fn(async () => ({ degraded }))
    const { store, api } = make({ putConfig, getStatus })
    await store.load()
    const getConfigCalls = (api.getConfig as ReturnType<typeof vi.fn>).mock.calls.length
    degraded = true

    store.apply((c) => { c.screens[0].pages[0].items[0].x = 12 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    await tick()

    expect(store.state.degraded).toBe(true)
    expect(store.state.status).toBe('error')
    expect(store.state.config!.screens[0].pages[0].items[0].x).toBe(12)
    expect((api.getConfig as ReturnType<typeof vi.fn>).mock.calls.length).toBe(getConfigCalls)
  })
})

describe('undo / redo', () => {
  it('walks back and forward through the snapshots', async () => {
    const { store } = make()
    await store.load()
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 8 })
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 16 })
    expect(store.canUndo.value).toBe(true)
    store.undo()
    expect(store.state.config!.screens[0].pages[0].items[0].x).toBe(8)
    store.undo()
    expect(store.state.config!.screens[0].pages[0].items[0].x).toBe(0)
    expect(store.canUndo.value).toBe(false)
    store.redo()
    expect(store.state.config!.screens[0].pages[0].items[0].x).toBe(8)
    store.redo()
    expect(store.state.config!.screens[0].pages[0].items[0].x).toBe(16)
    expect(store.canRedo.value).toBe(false)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('a new mutation clears the redo stack and the stack is capped', async () => {
    const { store } = make()
    await store.load()
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 8 })
    store.undo()
    expect(store.canRedo.value).toBe(true)
    store.apply((c) => { c.screens[0].pages[0].items[0].y = 4 })
    expect(store.canRedo.value).toBe(false)
    for (let i = 0; i < UNDO_LIMIT + 10; i++) store.apply((c) => { c.screens[0].pages[0].items[0].x = i % 8 })
    let undone = 0
    while (store.canUndo.value) { store.undo(); undone++ }
    expect(undone).toBe(UNDO_LIMIT)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('gives a new tile the screen\'s default opacity, and leaves the placed ones alone', async () => {
    const { store } = make()
    await store.load()
    store.apply((c) => { c.screens[0].display.tileOpacity = 0.5 })
    store.addWidget('clock')
    const added = items(store)[1].instanceId
    expect(widgetsOf(store)[added].opacity).toBe(0.5)
    expect(widgetsOf(store)['clock-1'].opacity).toBeUndefined()
    // Solid is the default and is stored as an absent key, so a tile added then carries none.
    store.apply((c) => { c.screens[0].display.tileOpacity = undefined })
    store.addWidget('clock')
    expect(widgetsOf(store)[items(store)[2].instanceId].opacity).toBeUndefined()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('drops a selection that no longer exists after an undo', async () => {
    const { store } = make()
    await store.load()
    store.addWidget('clock')
    const added = items(store)[1].instanceId
    expect(store.state.selectedId).toBe(added)
    store.undo()
    expect(store.state.selectedId).toBeNull()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('server errors', () => {
  it('shows the message, clears the undo stack and reloads the server config, then settles back to saved', async () => {
    const remote = config()
    remote.screens[0].pages[0].name = 'Depuis le serveur'
    const { store } = make({
      putConfig: vi.fn(async () => { throw new Error('page home: clock-1 hors grille') }),
      getConfig: vi.fn(async () => remote),
    })
    await store.load()
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 60 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    // The recovery reload succeeded: local now matches the server, so status goes back to
    // 'saved' (an incoming socket push must not be ignored forever because of a past error).
    expect(store.state.status).toBe('saved')
    expect(store.state.toast).toBe('page home: clock-1 hors grille')
    expect(store.state.config!.screens[0].pages[0].name).toBe('Depuis le serveur')
    expect(store.canUndo.value).toBe(false)
  })

  it('falls back to String(e) for a rejection that is not an Error, never "undefined"', async () => {
    const { store } = make({
      putConfig: vi.fn(async () => { throw 'boom' }), // eslint-disable-line @typescript-eslint/no-throw-literal
      getConfig: vi.fn(async () => config()),
    })
    await store.load()
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 60 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(store.state.toast).toBe('boom')
  })

  it('keeps the error and the local config when the recovery reload also fails', async () => {
    let getConfigCalls = 0
    const { store } = make({
      putConfig: vi.fn(async () => { throw new Error('page home: clock-1 hors grille') }),
      // First call (in load()) succeeds; the recovery call made after the failed save fails too.
      getConfig: vi.fn(async () => {
        getConfigCalls++
        if (getConfigCalls > 1) throw new Error('reseau indisponible')
        return config()
      }),
    })
    await store.load()
    store.apply((c) => { c.screens[0].pages[0].items[0].x = 60 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(store.state.status).toBe('error')
    expect(store.state.toast).toBe('page home: clock-1 hors grille')
    expect(store.state.config!.screens[0].pages[0].items[0].x).toBe(60)
    expect(store.canUndo.value).toBe(false)
  })
})

describe('remote config', () => {
  it('adopts a config pushed on the socket when nothing is pending', async () => {
    const { store, emit } = make()
    await store.load()
    const remote = config()
    remote.screens[0].pages[0].name = 'Autre onglet'
    emit(remote)
    expect(store.state.config!.screens[0].pages[0].name).toBe('Autre onglet')
  })

  it('ignores a pushed config while a save is scheduled', async () => {
    const { store, emit } = make()
    await store.load()
    store.apply((c) => { c.screens[0].pages[0].name = 'Saisie en cours' })
    emit(config())
    expect(store.state.config!.screens[0].pages[0].name).toBe('Saisie en cours')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('falls back to the Edge screen when a pushed config drops the one being edited', async () => {
    const { store, emit } = makeTwoScreens()
    await store.load()
    store.selectScreen('ipad')
    store.selectPage(0)
    emit(config())
    expect(store.state.screenId).toBe('edge')
    expect(store.state.pageIndex).toBe(0)
    expect(store.screen.value!.id).toBe('edge')
  })
})

describe('widgets', () => {
  it('addWidget creates a widget and its placement, in the first free spot, and selects it', async () => {
    const { store } = make()
    await store.load()
    store.addWidget('clock')
    const placed = items(store)[1]
    expect(placed).toMatchObject({ x: 16, y: 0, w: 16, h: 4 })
    expect(widgetsOf(store)[placed.instanceId]).toMatchObject({ widgetId: 'clock', showTitle: true, settings: {} })
    expect(store.state.selectedId).toBe(placed.instanceId)
    expect(store.selected.value).toMatchObject({ instanceId: placed.instanceId, widgetId: 'clock', x: 16 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('addWidget reports when the page is full', async () => {
    const { store } = make()
    await store.load()
    store.apply((c) => { c.screens[0].pages[0].items[0] = { ...c.screens[0].pages[0].items[0], w: 64, h: 16 } })
    store.addWidget('clock')
    expect(store.state.toast).toBe('Pas de place libre sur cette page')
    expect(items(store)).toHaveLength(1)
    expect(Object.keys(widgetsOf(store))).toEqual(['clock-1'])
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('duplicateWidget makes a new widget with the same appearance and settings, next to the original', async () => {
    const { store } = make()
    await store.load()
    store.updateInstance('clock-1', { accentMode: 'fill', bgColor: '#123456', title: 'Paris', settings: { seconds: true } })
    store.duplicateWidget('clock-1')
    const copy = items(store)[1]
    expect(copy).toMatchObject({ x: 16, y: 0, w: 16, h: 4 })
    expect(copy.instanceId).not.toBe('clock-1')
    expect(widgetsOf(store)[copy.instanceId]).toMatchObject({ widgetId: 'clock', accentMode: 'fill', bgColor: '#123456', title: 'Paris', settings: { seconds: true } })
    // A copy, not a reference: editing one leaves the other alone.
    store.updateInstance(copy.instanceId, { settings: { seconds: false } })
    expect(widgetsOf(store)['clock-1'].settings).toEqual({ seconds: true })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('others() excludes the given instance', async () => {
    const { store } = make()
    await store.load()
    expect(store.others()).toEqual([{ x: 0, y: 0, w: 16, h: 4 }])
    expect(store.others('clock-1')).toEqual([])
  })

  it('updateInstance keeps geometry out of the shared widget', async () => {
    const { store } = make()
    await store.load()
    store.updateInstance('clock-1', { x: 4, title: 'Paris' })
    expect(items(store)[0]).toEqual({ instanceId: 'clock-1', x: 4, y: 0, w: 16, h: 4 })
    expect(widgetsOf(store)['clock-1']).toEqual({ widgetId: 'clock', showTitle: true, settings: {}, title: 'Paris' })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('pages', () => {
  it('duplicatePage copies its tiles as new widgets', async () => {
    const { store } = make()
    await store.load()
    store.updateInstance('clock-1', { settings: { seconds: true } })
    store.duplicatePage(0)
    expect(store.state.pageIndex).toBe(1)
    const copy = items(store, 0, 1)[0]
    expect(copy).toMatchObject({ x: 0, y: 0, w: 16, h: 4 })
    expect(copy.instanceId).not.toBe('clock-1')
    expect(widgetsOf(store)[copy.instanceId]).toMatchObject({ widgetId: 'clock', settings: { seconds: true } })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('removePage drops the widgets it alone showed, and keeps the shared ones', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.addPage()
    store.addWidget('clock')
    const only = items(store, 0, 1)[0].instanceId
    store.placeExisting('cpu-1')
    store.removePage(1)
    expect(store.state.config!.screens[0].pages).toHaveLength(1)
    expect(widgetsOf(store)[only]).toBeUndefined()
    expect(widgetsOf(store)['cpu-1']).toBeDefined()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('moving a tile to another page', () => {
  /** The same fixture with an empty second page to move the clock onto. */
  const twoPages = (): Config => {
    const cfg = config()
    cfg.screens[0].pages.push({ id: 'two', name: 'Deux', items: [] })
    return cfg
  }
  const makeTwo = (mutate: (c: Config) => void = () => {}) => make({
    getConfig: vi.fn(async () => { const c = twoPages(); mutate(c); return c }),
  })

  it('moves the placement and follows it to the target page', async () => {
    const { store } = makeTwo()
    await store.load()
    store.updateInstance('clock-1', { accentMode: 'fill', title: 'Paris', settings: { seconds: true } })
    store.moveWidget('clock-1', 1)
    expect(items(store, 0, 0)).toHaveLength(0)
    expect(items(store, 0, 1)[0]).toEqual({ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 })
    expect(widgetsOf(store)['clock-1']).toMatchObject({ accentMode: 'fill', title: 'Paris', settings: { seconds: true } })
    expect(store.state.pageIndex).toBe(1)
    expect(store.state.selectedId).toBe('clock-1')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('refuses a full target page and changes nothing at all', async () => {
    const { store } = makeTwo((c) => {
      c.widgets['clock-2'] = { widgetId: 'clock', showTitle: true, settings: {} }
      c.screens[0].pages[1].items.push({ instanceId: 'clock-2', x: 0, y: 0, w: 64, h: 16 })
    })
    await store.load()
    expect(store.canUndo.value).toBe(false)
    store.moveWidget('clock-1', 1)
    expect(store.state.toast).toBe('Pas de place sur Deux pour Horloge')
    expect(items(store, 0, 0)).toHaveLength(1)
    expect(items(store, 0, 1)).toHaveLength(1)
    expect(store.state.pageIndex).toBe(0)
    // Nothing was applied, so the move left no snapshot behind either.
    expect(store.canUndo.value).toBe(false)
    expect(store.state.status).toBe('saved')
  })

  it('undoes as one step', async () => {
    const { store } = makeTwo()
    await store.load()
    store.moveWidget('clock-1', 1)
    store.undo()
    expect(items(store, 0, 0).map((p) => p.instanceId)).toEqual(['clock-1'])
    expect(items(store, 0, 1)).toHaveLength(0)
    expect(store.canUndo.value).toBe(false)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('copying settings from another instance', () => {
  it('copies every key onto another tile, as one undo step', async () => {
    const { store } = make()
    await store.load()
    store.duplicateWidget('clock-1')
    const target = items(store)[1].instanceId
    store.updateInstance('clock-1', { settings: { seconds: true, city: 'Paris' } })
    const source = widgetsOf(store)['clock-1']
    // What CopySettingsFrom emits: the whole settings object, through the usual update path.
    store.updateInstance(target, { settings: { ...source.settings } })
    expect(widgetsOf(store)[target].settings).toEqual({ seconds: true, city: 'Paris' })
    store.undo()
    expect(widgetsOf(store)[target].settings).toEqual({})
    expect(widgetsOf(store)['clock-1'].settings).toEqual({ seconds: true, city: 'Paris' })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('copies a tile’s settings onto a bar widget, as one undo step', async () => {
    const { store } = make({ getWidgets: vi.fn(async () => barWidgets) })
    await store.load()
    store.addNavWidget('clock')
    const navId = store.screen.value!.nav[0].instanceId
    store.updateInstance('clock-1', { settings: { compactDate: true, seconds: true } })
    const source = widgetsOf(store)['clock-1']
    store.updateNavWidget(navId, { settings: { ...source.settings } })
    expect(widgetsOf(store)[navId].settings).toEqual({ compactDate: true, seconds: true })
    store.undo()
    expect(widgetsOf(store)[navId].settings).toEqual({})
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('nav bar height', () => {
  it('a 40 px bar frees a 17th row, and the default stays an absent key', async () => {
    const { store } = make()
    await store.load()
    store.setNavHeight(40)
    expect(store.state.config!.screens[0].display).toMatchObject({ navHeight: 40, rows: 17 })
    store.setNavHeight(80)
    expect(store.state.config!.screens[0].display.navHeight).toBeUndefined()
    expect(store.state.config!.screens[0].display.rows).toBe(16)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('refuses to give the row back while a widget still occupies it', async () => {
    const { store } = make()
    await store.load()
    store.setNavHeight(40)
    store.updateInstance('clock-1', { y: 13, h: 4 })
    store.setNavHeight(80)
    expect(store.state.toast).toBe('Des widgets occupent la dernière ligne')
    expect(store.state.config!.screens[0].display).toMatchObject({ navHeight: 40, rows: 17 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('checks every page, not just the one being edited', async () => {
    const { store } = make()
    await store.load()
    store.setNavHeight(40)
    store.duplicatePage(0)
    store.updateInstance(items(store, 0, 1)[0].instanceId, { y: 16, h: 1 })
    store.selectPage(0)
    store.setNavHeight(80)
    expect(store.state.toast).toBe('Des widgets occupent la dernière ligne')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('setNavHeight on a device screen recomputes rows from its viewport', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.selectScreen('ipad')
    // 1376 × 1032: (1032 − 40) / 40 = 24 rows, (1032 − 80) / 40 = 23.
    store.setNavHeight(40)
    expect(store.state.config!.screens[1].display).toMatchObject({ navHeight: 40, rows: 24 })
    store.setNavHeight(80)
    expect(store.state.config!.screens[1].display.rows).toBe(23)
    expect(store.state.config!.screens[1].display.navHeight).toBeUndefined()
    // The Edge was not touched.
    expect(store.state.config!.screens[0].display).toMatchObject({ rows: 16 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('navigation bar widgets', () => {
  const makeBar = () => make({ getWidgets: vi.fn(async () => barWidgets) })
  const bar = (store: Store) => store.state.config!.screens[0].nav
  const ids = (store: Store) => bar(store).map((w) => w.instanceId)

  it('adds a new widget that declares a compact rendering, on the left by default', async () => {
    const { store } = makeBar()
    await store.load()
    expect(bar(store)).toEqual([])
    store.addNavWidget('clock')
    const [added] = bar(store)
    expect(added).toEqual({ instanceId: added.instanceId, slot: 'left' })
    expect(added.instanceId).toMatch(/^clock-/)
    expect(widgetsOf(store)[added.instanceId]).toMatchObject({ widgetId: 'clock', settings: {} })
    expect(store.canUndo.value).toBe(true)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('refuses a widget without a compact rendering, and an unknown one', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('plain')
    expect(bar(store)).toEqual([])
    expect(store.state.toast).toMatch(/rendu compact/)
    store.addNavWidget('ghost')
    expect(bar(store)).toEqual([])
    expect(store.state.toast).toMatch(/inconnu/)
  })

  it('refuses a widget once the clusters would reach the page dots', async () => {
    // 64 columns, 10 kept for the dots: ten 5-cell clocks fit (50), the eleventh (55) does not.
    const { store } = makeBar()
    await store.load()
    for (let i = 0; i < 11; i++) store.addNavWidget('clock')
    expect(bar(store)).toHaveLength(10)
    expect(store.state.toast).toMatch(/dots|points/)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('moves a widget to the other cluster', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    const [id] = ids(store)
    store.updateNavWidget(id, { slot: 'right' })
    expect(bar(store)[0].slot).toBe('right')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('reorders within a side only, ignoring the widgets of the other one', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    store.addNavWidget('cpu')
    store.addNavWidget('clock')
    const [a, b, c] = ids(store)
    // b sits on the right, between a and c: it must not take part in their ordering.
    store.updateNavWidget(b, { slot: 'right' })

    store.moveNavWidget(c, -1)
    expect(ids(store)).toEqual([c, b, a])
    expect(bar(store).map((w) => w.slot)).toEqual(['left', 'right', 'left'])

    // Each is now at an end of its own side, and b is alone on its side: all no-ops.
    const settled = ids(store)
    store.moveNavWidget(c, -1)
    store.moveNavWidget(a, 1)
    store.moveNavWidget(b, -1)
    store.moveNavWidget(b, 1)
    expect(ids(store)).toEqual(settled)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('patches the settings of the shared widget, and the slot of the bar item', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    const [id] = ids(store)
    store.updateNavWidget(id, { settings: { compactDate: true }, slot: 'right' })
    expect(widgetsOf(store)[id].settings).toEqual({ compactDate: true })
    expect(bar(store)[0]).toEqual({ instanceId: id, slot: 'right' })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('turns the popover on, and drops the key again when it is turned off', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    const [id] = ids(store)
    store.updateNavWidget(id, { popup: true })
    expect(bar(store)[0].popup).toBe(true)
    expect(store.canUndo.value).toBe(true)
    // Off is stored as a missing key, so an untouched bar keeps the config it had.
    store.updateNavWidget(id, { popup: undefined })
    expect('popup' in bar(store)[0]).toBe(false)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('removes an entry, and its widget with it when the bar was its only place', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    store.addNavWidget('cpu')
    const [first, second] = ids(store)
    store.removeNavWidget(second)
    expect(ids(store)).toEqual([first])
    expect(widgetsOf(store)[second]).toBeUndefined()
    store.removeNavWidget(first)
    expect(bar(store)).toEqual([])
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('undoes an addition, widget included', async () => {
    const { store } = makeBar()
    await store.load()
    store.addNavWidget('clock')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    store.undo()
    expect(bar(store)).toEqual([])
    expect(Object.keys(widgetsOf(store))).toEqual(['clock-1'])
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('screens', () => {
  it('starts on the Edge screen and keeps the selected one across saves', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    expect(store.state.screenId).toBe('edge')
    store.selectScreen('ipad')
    expect(store.screen.value!.id).toBe('ipad')
    expect(store.grid.value).toEqual({ cols: 34, rows: 23 })
    store.updateInstance('clock-1', { x: 2 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(store.state.screenId).toBe('ipad')
  })

  it('selectScreen goes to its first page and drops the selection; an unknown id is ignored', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.select('clock-1')
    store.selectScreen('ipad')
    expect(store.state.pageIndex).toBe(0)
    expect(store.state.selectedId).toBeNull()
    store.selectScreen('nowhere')
    expect(store.state.screenId).toBe('ipad')
  })

  it('updateInstance of a setting shows on both screens', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.selectScreen('ipad')
    store.select('clock-1')
    store.updateInstance('clock-1', { settings: { seconds: true }, title: 'Paris' })
    expect(store.selected.value).toMatchObject({ settings: { seconds: true }, title: 'Paris', x: 0, w: 8 })
    store.selectScreen('edge')
    store.select('clock-1')
    expect(store.selected.value).toMatchObject({ settings: { seconds: true }, title: 'Paris', x: 0, w: 16 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('updateInstance of geometry moves only this screen\'s placement', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.selectScreen('ipad')
    store.updateInstance('clock-1', { x: 10, y: 2 })
    expect(items(store, 1)[0]).toEqual({ instanceId: 'clock-1', x: 10, y: 2, w: 8, h: 4 })
    expect(items(store, 0)[0]).toEqual({ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 })
    expect(widgetsOf(store)['clock-1']).not.toHaveProperty('x')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('removeFromScreen keeps a widget shown elsewhere', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.selectScreen('ipad')
    store.select('clock-1')
    expect(store.isLastPlace('clock-1')).toBe(false)
    store.removeFromScreen('clock-1')
    expect(items(store, 1).map((p) => p.instanceId)).toEqual(['cpu-1'])
    expect(items(store, 0).map((p) => p.instanceId)).toEqual(['clock-1'])
    expect(widgetsOf(store)['clock-1']).toBeDefined()
    expect(store.state.selectedId).toBeNull()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('removeFromScreen deletes a widget on its last place', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.selectScreen('ipad')
    expect(store.isLastPlace('cpu-1')).toBe(true)
    store.removeFromScreen('cpu-1')
    expect(items(store, 1).map((p) => p.instanceId)).toEqual(['clock-1'])
    expect(widgetsOf(store)['cpu-1']).toBeUndefined()
    store.undo()
    expect(widgetsOf(store)['cpu-1']).toBeDefined()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('removeFromScreen takes a widget out of this screen\'s bar too', async () => {
    // On the iPad the clock sits in the bar rather than on the page.
    const { store } = makeTwoScreens((c) => {
      c.screens[1].pages[0].items.shift()
      c.screens[1].nav.push({ instanceId: 'clock-1', slot: 'left' })
    })
    await store.load()
    store.selectScreen('ipad')
    expect(store.isLastPlace('clock-1')).toBe(false)
    store.removeNavWidget('clock-1')
    expect(store.state.config!.screens[1].nav).toEqual([])
    expect(items(store, 1).map((p) => p.instanceId)).toEqual(['cpu-1'])
    expect(widgetsOf(store)['clock-1']).toBeDefined()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('removeScreen refuses the last screen', async () => {
    const { store } = make()
    await store.load()
    store.removeScreen('edge')
    expect(store.state.config!.screens).toHaveLength(1)
    expect(store.state.toast).toBe('Il faut au moins un écran')
    expect(store.canUndo.value).toBe(false)
  })

  it('removeScreen drops widgets shown only there', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.selectScreen('ipad')
    store.removeScreen('ipad')
    expect(store.state.config!.screens.map((s) => s.id)).toEqual(['edge'])
    expect(Object.keys(widgetsOf(store))).toEqual(['clock-1'])
    expect(store.state.screenId).toBe('edge')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('placeExisting refuses a widget already on this screen', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.placeExisting('clock-1')
    expect(store.state.toast).toMatch(/déjà/)
    expect(items(store, 0)).toHaveLength(1)
    expect(store.canUndo.value).toBe(false)
  })

  it('placeExisting places the same widget, at its default size, and selects it', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.placeExisting('cpu-1')
    expect(items(store, 0)[1]).toEqual({ instanceId: 'cpu-1', x: 16, y: 0, w: 16, h: 4 })
    expect(Object.keys(widgetsOf(store)).sort()).toEqual(['clock-1', 'cpu-1'])
    expect(store.state.selectedId).toBe('cpu-1')
    expect(store.isLastPlace('cpu-1')).toBe(false)
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('placeExisting with a rectangle refuses an occupied one', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.placeExisting('cpu-1', { x: 4, y: 0, w: 8, h: 4 })
    expect(store.state.toast).toBe('Cette position est occupée')
    expect(items(store, 0)).toHaveLength(1)
  })

  it('undo restores the selected screen\'s previous layout', async () => {
    const { store } = makeTwoScreens()
    await store.load()
    store.selectScreen('ipad')
    store.updateInstance('cpu-1', { x: 20 })
    store.removeFromScreen('clock-1')
    store.undo()
    store.undo()
    expect(items(store, 1)).toEqual([
      { instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 },
      { instanceId: 'cpu-1', x: 8, y: 0, w: 8, h: 4 },
    ])
    expect(store.state.screenId).toBe('ipad')
    expect(store.screen.value!.id).toBe('ipad')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('addScreen makes an empty device screen sized from its viewport, and selects it', async () => {
    const { store } = make()
    await store.load()
    const id = store.addScreen({ name: 'iPad de test', kind: 'device', viewport: { width: 1376, height: 1032 }, orientation: 'landscape', prefill: null })
    expect(id).toBe('ipad-de-test')
    const added = store.state.config!.screens[1]
    expect(added).toMatchObject({
      id, name: 'iPad de test', kind: 'device', nav: [],
      display: { cols: 34, rows: 24, cell: 40, navHeight: 40, orientation: 'landscape', viewport: { width: 1376, height: 1032 } },
    })
    expect(added.pages).toHaveLength(1)
    expect(added.pages[0].items).toEqual([])
    expect(store.state.screenId).toBe(id)
    // A second one by the same name gets a free id.
    expect(store.addScreen({ name: 'iPad de test', kind: 'edge', prefill: null })).toBe('ipad-de-test-2')
    expect(store.state.config!.screens[2].display).toMatchObject({ cols: 64, rows: 16, cell: 40 })
    // An Edge screen keeps the default 80 px bar, stored as an absent key.
    expect(store.state.config!.screens[2].display.navHeight).toBeUndefined()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('addScreen with a pre-fill shares the widgets it places', async () => {
    const { store } = make({ getWidgets: vi.fn(async () => barWidgets) })
    await store.load()
    const id = store.addScreen({
      name: 'Bureau', kind: 'edge',
      prefill: {
        from: 'edge',
        pages: [{ id: 'home', name: 'Accueil', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }] }],
        nav: [{ instanceId: 'clock-1', slot: 'left' }],
      },
    })
    expect(id).toBe('bureau')
    const added = store.state.config!.screens[1]
    expect(added.pages[0].items).toEqual([{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }])
    // Once per screen: the bar copy of a widget already placed on a page is dropped.
    expect(added.nav).toEqual([])
    expect(Object.keys(widgetsOf(store))).toEqual(['clock-1'])
    store.undo()
    expect(store.state.config!.screens).toHaveLength(1)
    expect(store.state.screenId).toBe('edge')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('addScreen gives a device screen the 40 px bar even when pre-filled from an 80 px Edge', async () => {
    const { store } = make()
    await store.load()
    store.state.config!.screens[0].display.navOpacity = 0.5
    expect(store.state.config!.screens[0].display.navHeight).toBeUndefined()
    store.addScreen({
      name: 'Tablet', kind: 'device', viewport: { width: 1180, height: 820 }, orientation: 'landscape',
      prefill: { from: 'edge', pages: [], nav: [] },
    })
    const added = store.state.config!.screens.at(-1)!
    // The look is copied, the bar height is not: (820 - 40) / 40 = 19 rows.
    expect(added.display).toMatchObject({ cols: 29, rows: 19, navHeight: 40, navOpacity: 0.5 })
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })

  it('addScreen refuses a device screen without a usable viewport', async () => {
    const { store } = make()
    await store.load()
    expect(store.addScreen({ name: 'Tablet', kind: 'device', prefill: null })).toBe('')
    // 30 px wide is less than one 40 px column; 70 px tall leaves no row under the 40 px bar.
    expect(store.addScreen({ name: 'Tablet', kind: 'device', viewport: { width: 30, height: 800 }, prefill: null })).toBe('')
    expect(store.addScreen({ name: 'Tablet', kind: 'device', viewport: { width: 800, height: 70 }, prefill: null })).toBe('')
    expect(store.state.config!.screens).toHaveLength(1)
    expect(store.state.toast).not.toBe('')
    expect(store.canUndo.value).toBe(false)
  })

  it('renameScreen renames, and ignores an empty name', async () => {
    const { store } = make()
    await store.load()
    store.renameScreen('edge', '  Bureau  ')
    expect(store.state.config!.screens[0].name).toBe('Bureau')
    store.renameScreen('edge', '   ')
    expect(store.state.config!.screens[0].name).toBe('Bureau')
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
  })
})

describe('modals', () => {
  it('starts with no modal open', () => {
    const { store } = make()
    expect(store.state.modal).toBeNull()
  })

  it('opens, switches and closes a modal', () => {
    const { store } = make()
    store.openModal('screen')
    expect(store.state.modal).toBe('screen')
    store.openModal('connections')
    expect(store.state.modal).toBe('connections')
    store.closeModal()
    expect(store.state.modal).toBeNull()
  })

  it('leaves the selection alone: the inspector is no longer a tab', async () => {
    const { store } = make()
    await store.load()
    store.openModal('connections')
    store.select('clock-1')
    expect(store.state.modal).toBe('connections')
    expect(store.state.selectedId).toBe('clock-1')
  })
})

describe('freeInstanceId', () => {
  it('stays within the 64 characters the server accepts, however long the widget id', () => {
    const long = 'w'.repeat(60)
    const id = freeInstanceId(config(), long)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(id).toMatch(new RegExp(`^${'w'.repeat(57)}-[a-z0-9]{1,6}$`))
  })
  it('keeps a short widget id whole', () => {
    expect(freeInstanceId(config(), 'clock')).toMatch(/^clock-[a-z0-9]{1,6}$/)
  })
})
