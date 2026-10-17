import { reactive, computed, watch, type ComputedRef } from 'vue'
import { api as realApi } from '../shared/api'
import { pick, setLocale, t } from '../shared/i18n'
import { useSocket } from '../shared/socket'
import type { Config, NavHeight, NavItem, Page, Placement, Screen, ScreenDisplay, Widget, WidgetInstance, WidgetManifest, WidgetPermissionSet, WidgetSource, WidgetsResponse } from '../shared/types'
import { DEFAULT_NAV_HEIGHT, MAX_NAV_WIDGETS, ROWS_BY_NAV_HEIGHT, compactWidth, mergeSettings, navHasRoom, navWiderClusterWidth } from '../shared/types'
import { DEVICE_CELL, DEVICE_NAV_HEIGHT, deviceGrid, pickScreen, screensShowing, tileOf } from '../shared/screens'
import { fits, largestFreeSpot, type Grid, type Rect } from './layout'

export type Mode = 'edit' | 'test'
/** The modal dialogs opened from the top bar. Kept in the store so a widget setting can open one. */
export type ModalName = 'screen' | 'connections' | 'marketplace'
export type Status = 'saved' | 'saving' | 'error'

/** Edits are grouped this long before one PUT of the whole config. */
export const SAVE_DEBOUNCE_MS = 300
/** Snapshots kept for undo; older ones fall off the bottom. */
export const UNDO_LIMIT = 50
/** Drag-and-drop mime type set by the widget library's drag source. */
export const DND_TYPE = 'application/x-fremkit-widget'
/** A drag of a widget that already exists on another screen: the payload is its instance id. */
export const DND_EXISTING_TYPE = 'application/x-fremkit-existing-widget'
/** Mirrors the server's 409 body: saving is impossible until the file on disk is fixed. */
export const degradedMessage = (): string => t('admin.store.degraded')

export interface AdminState {
  config: Config | null
  manifests: Record<string, WidgetManifest>
  /** Where each widget came from, so the library can mark the ones the user installed. */
  sources: Record<string, WidgetSource>
  /** What each manifest asks for, beside what it was granted. See `WidgetsResponse.asks`. */
  asks: Record<string, WidgetPermissionSet>
  catalogErrors: { id: string; error: string }[]
  /**
   * The screen being edited. Empty until a config is loaded, and whenever the screen it named
   * went away: `screen` then reads the Edge's, and the next mutation writes that id back.
   */
  screenId: string
  /** Within the selected screen. */
  pageIndex: number
  selectedId: string | null
  dragWidgetId: string | null
  mode: Mode
  /** The dialog currently open above the editor, or null. */
  modal: ModalName | null
  /**
   * The connection type the Connections dialog should open a *new* connection on, or ''.
   *
   * Cleared by `openModal`, so it only ever survives the one open it was set for: a stale value
   * would put somebody back on a form they had already left.
   */
  newConnectionType: string
  status: Status
  toast: string
  /** The server cannot read data/fremkit.json: nothing may be saved until it is fixed. */
  degraded: boolean
}

export interface AdminApi {
  getConfig(): Promise<Config>
  getStatus(): Promise<{ degraded: boolean }>
  getWidgets(): Promise<WidgetsResponse>
  putConfig(cfg: Config): Promise<Config>
  rescan(): Promise<WidgetsResponse>
}

/** What `addScreen` takes: the new screen's name and kind, and what to fill it with. */
export interface NewScreen {
  name: string
  kind: 'edge' | 'device'
  /**
   * A device's viewport in its orientation, in CSS px; ignored for an Edge screen. Required for a
   * device, and large enough for at least one 40 px column and one row under the bar.
   */
  viewport?: { width: number; height: number }
  orientation?: 'landscape' | 'portrait'
  /**
   * Pages and bar to start from, placing existing widgets; `from` is the screen they come from.
   * They must already be arranged for the new screen's grid — `arrangeInto` (`./arrange`) is what
   * produces them, and what the preview shows. `addScreen` does not re-check that they fit.
   */
  prefill: { from: string; pages: Page[]; nav: NavItem[] } | null
}

/** What `updateNavWidget` takes: the bar entry's own keys, and the shared widget's settings. */
export type NavWidgetPatch = Partial<Pick<NavItem, 'slot' | 'popup'>> & { settings?: Record<string, unknown> }

export interface StoreDeps {
  api: AdminApi
  subscribeConfig: (cb: (cfg: Config) => void) => () => void
  debounceMs?: number
}

export interface AdminStore {
  state: AdminState
  screen: ComputedRef<Screen | null>
  page: ComputedRef<Page | null>
  selected: ComputedRef<WidgetInstance | null>
  grid: ComputedRef<Grid>
  canUndo: ComputedRef<boolean>
  canRedo: ComputedRef<boolean>
  load(): Promise<void>
  rescan(): Promise<void>
  apply(mutate: (cfg: Config) => void): void
  undo(): void
  redo(): void
  flush(): Promise<void>
  others(ignoreId?: string): Rect[]
  select(id: string | null): void
  selectScreen(id: string): void
  selectPage(i: number): void
  setMode(mode: Mode): void
  openModal(name: ModalName): void
  /**
   * Opens Connections straight onto a new connection of `typeId`.
   *
   * The reason it exists: a widget that declares a connection is useless until one is created,
   * and its own settings form is where somebody notices. Sending them to a list and asking them
   * to find the right type among nine is where that attempt ends.
   */
  openNewConnection(typeId: string): void
  closeModal(): void
  setDragWidget(id: string | null): void
  dismissToast(): void
  setNavHeight(height: NavHeight): void
  addPage(): void
  renamePage(i: number, name: string): void
  duplicatePage(i: number): void
  removePage(i: number): void
  movePage(i: number, delta: number): void
  placeWidget(widgetId: string, rect: Rect): void
  addWidget(widgetId: string): void
  placeExisting(instanceId: string, rect?: Rect): void
  updateInstance(instanceId: string, patch: Partial<WidgetInstance>): void
  duplicateWidget(instanceId: string): void
  moveWidget(instanceId: string, targetPageIndex: number): void
  removeFromScreen(instanceId: string): void
  /** True when no other screen shows the widget: removing it from this one deletes it. */
  isLastPlace(instanceId: string): boolean
  addScreen(input: NewScreen): string
  renameScreen(id: string, name: string): void
  removeScreen(id: string): void
  addNavWidget(widgetId: string): void
  removeNavWidget(instanceId: string): void
  moveNavWidget(instanceId: string, delta: number): void
  updateNavWidget(instanceId: string, patch: NavWidgetPatch): void
}

const uid = (): string => Math.random().toString(36).slice(2, 8)
const rectOf = (w: Placement): Rect => ({ x: w.x, y: w.y, w: w.w, h: w.h })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
/** The keys of a patch that belong to a placement rather than to the shared widget. */
const GEOMETRY: (keyof Rect)[] = ['x', 'y', 'w', 'h']
/** Mirrors the server's limit on a screen name. */
const SCREEN_NAME_MAX = 60
/** The Edge's grid: 64 columns of 40 px cells. */
const EDGE_COLS = 64
const EDGE_CELL = 40
/**
 * What a pre-filled screen takes from the look of the one it came from. Not the bar's height: a
 * device screen keeps its own slim bar whatever its source has, and its rows were counted under it.
 */
const LOOK_KEYS = ['autoCycleSeconds', 'navOpacity', 'tileOpacity', 'adminGesture', 'background'] as const

/** Applies a patch, dropping the keys it sets to `undefined`: defaults are stored as absent keys. */
function patchInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete target[key]
    else target[key] = value
  }
}

/** A fresh instance id for a widget, never one the config already uses. */
/** Longest instance id the server accepts: `INSTANCE_ID_MAX` in server/src/config/schema.ts. */
const MAX_INSTANCE_ID = 64

/**
 * An instance id free in `cfg`: the widget id, cut so the whole stays within the server's 64
 * characters, then a dash and six random ones.
 */
export function freeInstanceId(cfg: Config, widgetId: string): string {
  const stem = widgetId.slice(0, MAX_INSTANCE_ID - 7)
  let id = `${stem}-${uid()}`
  while (Object.hasOwn(cfg.widgets, id)) id = `${stem}-${uid()}`
  return id
}

/** A page id free on that screen: `wanted` when it is, else a random one. */
function freePageId(pages: Page[], wanted?: string): string {
  if (wanted && !pages.some((p) => p.id === wanted)) return wanted
  let id = 'page-' + uid()
  while (pages.some((p) => p.id === id)) id = 'page-' + uid()
  return id
}

/** A screen id from its name — the slug the server accepts — suffixed until it is free. */
export function freeScreenId(name: string, taken: string[]): string {
  const base = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56).replace(/-+$/, '') || 'screen'
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** Deletes those of `ids` no screen shows any more: a widget lives only while it is placed. */
function dropUnplaced(cfg: Config, ids: string[]): void {
  for (const id of ids) {
    if (cfg.widgets[id] && !screensShowing(cfg, id).length) delete cfg.widgets[id]
  }
}

/** JSON with sorted keys, so two configs differing only in key order compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v)
}

export function createAdminStore(deps: StoreDeps): AdminStore {
  const debounceMs = deps.debounceMs ?? SAVE_DEBOUNCE_MS
  const state = reactive<AdminState>({
    newConnectionType: '',
    config: null, manifests: {}, sources: {}, asks: {}, catalogErrors: [],
    screenId: '', pageIndex: 0, selectedId: null, dragWidgetId: null,
    mode: 'edit', modal: null, status: 'saved', toast: '', degraded: false,
  })
  // Reactive arrays: canUndo/canRedo read their .length, and a plain array here would give
  // those computed refs no tracked dependency, so they'd never invalidate after the first read.
  const undoStack: Config[] = reactive([])
  const redoStack: Config[] = reactive([])
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSent = ''
  // Single-flight guard for putConfig. `inFlight` is true while a PUT is in the air; a mutation
  // that arrives during that window must never start a second, concurrent PUT (their responses
  // could land out of order and a stale one would overwrite a newer edit). Instead it sets
  // `dirty`, and the in-flight request's `finally` starts exactly one follow-up PUT — carrying
  // whatever the config looks like at that moment — once the first has settled. `current` lets
  // flush() wait for that whole in-flight-plus-retry chain, not just the first request.
  let inFlight = false
  let dirty = false
  let current: Promise<void> = Promise.resolve()
  // Bumped by every local mutation, so an await can tell whether the config moved under it.
  let localVersion = 0

  /**
   * The screen being edited: the selected one, or — before one is chosen, or once it is gone —
   * the one the Edge shows. Reading through `pickScreen` means a config set directly (a test, a
   * restore) is editable at once, before anything has synced `screenId`.
   */
  const screen = computed<Screen | null>(() => (state.config ? pickScreen(state.config, state.screenId || null) ?? null : null))
  const page = computed<Page | null>(() => screen.value?.pages[state.pageIndex] ?? null)
  /** The selected tile, joined with its shared widget: what the inspector and the keyboard edit. */
  const selected = computed<WidgetInstance | null>(() => {
    const placement = page.value?.items.find((p) => p.instanceId === state.selectedId)
    return placement && state.config ? tileOf(state.config, placement) : null
  })
  const grid = computed<Grid>(() => ({ cols: screen.value?.display.cols ?? 64, rows: screen.value?.display.rows ?? 16 }))
  const canUndo = computed(() => undoStack.length > 0)
  const canRedo = computed(() => redoStack.length > 0)

  const snapshot = (): Config => JSON.parse(JSON.stringify(state.config)) as Config
  const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  /**
   * Keeps the screen, page and selection pointing at things that exist. A screen that went away
   * (an undo, a push from another tab) falls back to the Edge's, on its first page.
   */
  function clampSelection(): void {
    const scr = screen.value
    if (!scr) return
    if (state.screenId !== scr.id) { state.screenId = scr.id; state.pageIndex = 0 }
    state.pageIndex = Math.max(0, Math.min(state.pageIndex, scr.pages.length - 1))
    if (state.selectedId && !page.value?.items.some((p) => p.instanceId === state.selectedId)) state.selectedId = null
  }

  /** The edited screen inside the config a mutation is handed. */
  const here = (cfg: Config): Screen => cfg.screens.find((x) => x.id === screen.value!.id)!
  /** What the user calls a widget: its own title, else its manifest's name. */
  const nameOf = (w: Widget): string => w.title?.trim() || pick(state.manifests[w.widgetId]?.name) || w.widgetId

  async function send(): Promise<void> {
    if (!state.config) return
    const body = snapshot()
    try {
      lastSent = stable(body)
      await deps.api.putConfig(body)
      // Only settle to 'saved' when nothing newer is queued (a debounce timer) or already
      // pending (dirty, about to be retried by kick()'s finally below).
      if (!dirty && !timer) state.status = 'saved'
    } catch (e) {
      state.status = 'error'
      state.toast = errorMessage(e)
      // A refusal may mean the server can no longer read the file: re-read the flag so the
      // banner appears and further edits stop being pushed.
      try { state.degraded = (await deps.api.getStatus()).degraded } catch { /* keep the last known state */ }
      // A newer edit already landed during this PUT (kick() retries it below), or the server is
      // serving defaults it could not read from disk — either way, never reload over the user.
      if (dirty || state.degraded) return
      // No newer edit is pending: the undo history no longer matches the server, and the
      // safest move is to resync with whatever the server actually has. If that resync also
      // fails, keep the original error visible and leave the local config untouched rather
      // than losing the user's in-progress edits.
      undoStack.length = 0
      redoStack.length = 0
      try {
        const before = localVersion
        const fresh = await deps.api.getConfig()
        // The user kept editing while that GET was in the air. Their work is newer than the
        // server's answer, so we keep it, stay in 'error' with the toast, and let the edit's
        // own pending send carry it to the server.
        // The failure is still the latest news until that retry lands, so keep showing it.
        if (localVersion !== before) { state.status = 'error'; return }
        state.config = fresh
        lastSent = stable(fresh)
        state.status = 'saved'
        clampSelection()
      } catch {
        // Recovery failed too: status stays 'error', toast keeps the save error,
        // local config is left as is.
      }
    }
  }

  /** Single-flight dispatcher: starts a PUT, or flags one to retry if one is already in flight. */
  function kick(): void {
    if (inFlight) { dirty = true; return }
    inFlight = true
    dirty = false
    current = send().finally(() => {
      inFlight = false
      if (dirty) kick()
    })
  }

  function schedule(): void {
    localVersion++
    if (state.degraded) {
      // Saving is off until the file on disk is fixed; the banner already says so.
      state.status = 'error'
      state.toast = degradedMessage()
      return
    }
    if (timer) clearTimeout(timer)
    state.status = 'saving'
    timer = setTimeout(() => { timer = undefined; kick() }, debounceMs)
  }

  function apply(mutate: (cfg: Config) => void): void {
    if (!state.config) return
    undoStack.push(snapshot())
    if (undoStack.length > UNDO_LIMIT) undoStack.shift()
    redoStack.length = 0
    mutate(state.config)
    clampSelection()
    schedule()
  }

  // The whole admin follows the config's language: loading one, undoing to one, or receiving one
  // over the config channel all go through `state.config`, so one watcher covers every path.
  watch(() => state.config?.locale, (next) => setLocale(next), { immediate: true })

  deps.subscribeConfig((cfg) => {
    // A pending or in-flight local save wins: never clobber what the user is editing.
    if (timer || state.status !== 'saved') return
    const next = stable(cfg)
    if (next === lastSent || (state.config && next === stable(state.config))) return
    state.config = cfg
    lastSent = next
    undoStack.length = 0
    redoStack.length = 0
    clampSelection()
  })

  const store: AdminStore = {
    state, screen, page, selected, grid, canUndo, canRedo,

    async load(): Promise<void> {
      const [cfg, widgets, status] = await Promise.all([deps.api.getConfig(), deps.api.getWidgets(), deps.api.getStatus()])
      state.config = cfg
      state.degraded = status.degraded
      lastSent = stable(cfg)
      state.manifests = widgets.widgets
      state.sources = widgets.sources
      state.asks = widgets.asks
      state.catalogErrors = widgets.errors
      undoStack.length = 0
      redoStack.length = 0
      state.status = 'saved'
      clampSelection()
    },

    async rescan(): Promise<void> {
      const widgets = await deps.api.rescan()
      state.manifests = widgets.widgets
      state.sources = widgets.sources
      state.asks = widgets.asks
      state.catalogErrors = widgets.errors
    },

    apply,

    undo(): void {
      const prev = undoStack.pop()
      if (!prev) return
      redoStack.push(snapshot())
      state.config = prev
      clampSelection()
      schedule()
    },

    redo(): void {
      const next = redoStack.pop()
      if (!next) return
      undoStack.push(snapshot())
      state.config = next
      clampSelection()
      schedule()
    },

    async flush(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = undefined; kick() }
      if (!inFlight) return
      while (inFlight) await current
    },

    others(ignoreId?: string): Rect[] {
      return (page.value?.items ?? []).filter((w) => w.instanceId !== ignoreId).map(rectOf)
    },

    select(id: string | null): void { state.selectedId = id },
    selectPage(i: number): void { state.pageIndex = i; state.selectedId = null },
    setMode(mode: Mode): void { state.mode = mode; if (mode === 'test') state.selectedId = null },
    openModal(name: ModalName): void { state.modal = name; state.newConnectionType = '' },
    openNewConnection(typeId: string): void { state.newConnectionType = typeId; state.modal = 'connections' },
    closeModal(): void { state.modal = null },
    setDragWidget(id: string | null): void { state.dragWidgetId = id },
    dismissToast(): void { state.toast = '' },

    selectScreen(id: string): void {
      if (!state.config?.screens.some((x) => x.id === id)) return
      state.screenId = id
      state.pageIndex = 0
      state.selectedId = null
    },

    /**
     * The nav bar and the board share the screen: a shorter bar gives the grid more rows, a
     * taller one takes them back. On the Edge that is the fixed 16/17; a device screen recomputes
     * them from the viewport it reported. Taking rows back is only possible while they are empty —
     * widgets are never pushed out of the grid, the change is refused instead.
     */
    setNavHeight(height: NavHeight): void {
      const scr = screen.value
      if (!scr) return
      const viewport = scr.display.viewport
      const rows = scr.kind === 'device' && viewport
        ? Math.max(1, deviceGrid(viewport.width, viewport.height, height).rows)
        : ROWS_BY_NAV_HEIGHT[height]
      if (rows < scr.display.rows && scr.pages.some((p) => p.items.some((w) => w.y + w.h > rows))) {
        state.toast = t('admin.store.lastRowOccupied')
        return
      }
      apply((c) => {
        const display = here(c).display
        // The default is stored as an absent key, so switching back leaves no trace in the file.
        if (height === DEFAULT_NAV_HEIGHT) delete display.navHeight
        else display.navHeight = height
        display.rows = rows
      })
    },

    addPage(): void {
      apply((c) => {
        const pages = here(c).pages
        pages.push({ id: freePageId(pages), name: t('admin.store.newPage'), items: [] })
        state.pageIndex = pages.length - 1
        state.selectedId = null
      })
    },

    renamePage(i: number, name: string): void {
      apply((c) => { here(c).pages[i].name = name })
    },

    /** The copy's tiles are new widgets, set up like the originals: editing one leaves the other alone. */
    duplicatePage(i: number): void {
      apply((c) => {
        const pages = here(c).pages
        const src = pages[i]
        const items: Placement[] = []
        for (const p of src.items) {
          const widget = c.widgets[p.instanceId]
          if (!widget) continue
          const id = freeInstanceId(c, widget.widgetId)
          c.widgets[id] = clone(widget)
          items.push({ ...p, instanceId: id })
        }
        pages.splice(i + 1, 0, { id: freePageId(pages), name: t('admin.store.pageCopy', { name: src.name }), items })
        state.pageIndex = i + 1
        state.selectedId = null
      })
    },

    /** The widgets that page alone showed go with it; those shown elsewhere stay. */
    removePage(i: number): void {
      if ((screen.value?.pages.length ?? 0) <= 1) { state.toast = t('admin.store.lastPage'); return }
      apply((c) => {
        const [removed] = here(c).pages.splice(i, 1)
        dropUnplaced(c, removed.items.map((p) => p.instanceId))
        if (state.pageIndex >= i) state.pageIndex = Math.max(0, state.pageIndex - 1)
        state.selectedId = null
      })
    },

    movePage(i: number, delta: number): void {
      const pages = screen.value?.pages
      const j = i + delta
      if (!pages || j < 0 || j >= pages.length) return
      apply((c) => {
        const list = here(c).pages
        const [moved] = list.splice(i, 1)
        list.splice(j, 0, moved)
        if (state.pageIndex === i) state.pageIndex = j
        else if (state.pageIndex === j) state.pageIndex = i
      })
    },

    /** A new widget and its placement, in one mutation: the server drops a widget placed nowhere. */
    placeWidget(widgetId: string, rect: Rect): void {
      if (!fits(rect, grid.value, store.others())) { state.toast = t('admin.store.occupied'); return }
      apply((c) => {
        const scr = here(c)
        const instanceId = freeInstanceId(c, widgetId)
        c.widgets[instanceId] = {
          widgetId, showTitle: true, settings: {},
          // The screen's default for new tiles, copied rather than referenced: the widget owns it.
          ...(scr.display.tileOpacity !== undefined ? { opacity: scr.display.tileOpacity } : {}),
        }
        scr.pages[state.pageIndex].items.push({ instanceId, x: rect.x, y: rect.y, w: rect.w, h: rect.h })
        state.selectedId = instanceId
      })
    },

    addWidget(widgetId: string): void {
      const manifest = state.manifests[widgetId]
      if (!manifest) { state.toast = t('admin.store.unknownWidget', { id: widgetId }); return }
      const spot = largestFreeSpot(manifest.defaultSize, manifest.minSize, grid.value, store.others())
      if (!spot) { state.toast = t('admin.store.noRoom'); return }
      store.placeWidget(widgetId, spot)
    },

    /**
     * Places a widget that already exists — shown on another screen — on this screen's current
     * page: the same widget, settings and all. At `rect` when given, else at its manifest's
     * default size in the largest free spot. A screen shows a widget at most once.
     */
    placeExisting(instanceId: string, rect?: Rect): void {
      const cfg = state.config
      const scr = screen.value
      if (!cfg || !scr || !page.value) return
      const widget = cfg.widgets[instanceId]
      if (!widget) { state.toast = t('admin.store.unknownWidget', { id: instanceId }); return }
      if (screensShowing(cfg, instanceId).some((x) => x.id === scr.id)) {
        state.toast = t('admin.store.alreadyOnScreen', { name: nameOf(widget) })
        return
      }
      let spot: Rect | null = rect ?? null
      if (spot) {
        if (!fits(spot, grid.value, store.others())) { state.toast = t('admin.store.occupied'); return }
      } else {
        const manifest = state.manifests[widget.widgetId]
        const min = manifest?.minSize ?? [1, 1]
        spot = largestFreeSpot(manifest?.defaultSize ?? min, min, grid.value, store.others())
        if (!spot) { state.toast = t('admin.store.noRoom'); return }
      }
      const at = spot
      apply((c) => {
        here(c).pages[state.pageIndex].items.push({ instanceId, x: at.x, y: at.y, w: at.w, h: at.h })
        state.selectedId = instanceId
      })
    },

    /**
     * One patch, two homes: `x/y/w/h` move this screen's placement, everything else changes the
     * shared widget — and so every screen showing it. A key set to `undefined` is dropped.
     */
    updateInstance(instanceId: string, patch: Partial<WidgetInstance>): void {
      const geometry: Partial<Rect> = {}
      const rest: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'instanceId') continue
        if (GEOMETRY.includes(key as keyof Rect)) { if (value !== undefined) geometry[key as keyof Rect] = value as number }
        else rest[key] = value
      }
      apply((c) => {
        if (Object.keys(geometry).length) {
          for (const p of here(c).pages) {
            const placement = p.items.find((x) => x.instanceId === instanceId)
            if (placement) Object.assign(placement, geometry)
          }
        }
        const widget = c.widgets[instanceId]
        if (widget && Object.keys(rest).length) patchInto(widget as unknown as Record<string, unknown>, rest)
      })
    },

    /** A new widget set up like the original, next to it on this page. */
    duplicateWidget(instanceId: string): void {
      const src = page.value?.items.find((p) => p.instanceId === instanceId)
      const widget = src && state.config?.widgets[instanceId]
      if (!src || !widget) return
      const min = state.manifests[widget.widgetId]?.minSize ?? [1, 1]
      const spot = largestFreeSpot([src.w, src.h], min, grid.value, store.others())
      if (!spot) { state.toast = t('admin.store.noRoom'); return }
      apply((c) => {
        const id = freeInstanceId(c, widget.widgetId)
        c.widgets[id] = clone(c.widgets[instanceId])
        here(c).pages[state.pageIndex].items.push({ instanceId: id, ...spot })
        state.selectedId = id
      })
    },

    /**
     * The same placement on another page of this screen: only its rectangle is recomputed, since
     * the target page has its own occupied cells. A page with no room refuses the move rather
     * than stacking tiles, and the editor follows the widget so the user sees where it landed.
     */
    moveWidget(instanceId: string, targetPageIndex: number): void {
      const cfg = state.config
      const src = page.value?.items.find((p) => p.instanceId === instanceId)
      const target = screen.value?.pages[targetPageIndex]
      if (!cfg || !src || !target || targetPageIndex === state.pageIndex) return
      const widgetId = cfg.widgets[instanceId]?.widgetId ?? ''
      const manifest = state.manifests[widgetId]
      const spot = largestFreeSpot([src.w, src.h], manifest?.minSize ?? [1, 1], grid.value, target.items.map(rectOf))
      if (!spot) {
        state.toast = t('admin.store.noRoomOnPage', { page: target.name, id: pick(manifest?.name) || widgetId })
        return
      }
      apply((c) => {
        const pages = here(c).pages
        const items = pages[state.pageIndex].items
        const i = items.findIndex((p) => p.instanceId === instanceId)
        if (i < 0) return
        items.splice(i, 1)
        pages[targetPageIndex].items.push({ instanceId, ...spot })
        state.pageIndex = targetPageIndex
        state.selectedId = instanceId
      })
    },

    /**
     * Takes the widget off this screen — its tile or its bar entry. When no other screen shows it,
     * that was its last place and the widget itself goes: the editor asks before calling this then.
     */
    removeFromScreen(instanceId: string): void {
      apply((c) => {
        const scr = here(c)
        for (const p of scr.pages) {
          const i = p.items.findIndex((x) => x.instanceId === instanceId)
          if (i >= 0) p.items.splice(i, 1)
        }
        const n = scr.nav.findIndex((x) => x.instanceId === instanceId)
        if (n >= 0) scr.nav.splice(n, 1)
        dropUnplaced(c, [instanceId])
        if (state.selectedId === instanceId) state.selectedId = null
      })
    },

    isLastPlace(instanceId: string): boolean {
      const cfg = state.config
      const scr = screen.value
      if (!cfg || !scr) return true
      return !screensShowing(cfg, instanceId).some((x) => x.id !== scr.id)
    },

    /**
     * A new screen, selected at once. A device screen takes its grid from the viewport it reported,
     * under the slim 40 px bar it gets (`DEVICE_NAV_HEIGHT`); an Edge screen takes the Edge's. A pre-fill places existing
     * widgets — shared, not copied — and brings the look of the screen it came from; whatever would
     * break the once-per-screen rule or overflow the bar is left out (an `arrangeInto` result never
     * has any). A device screen with no viewport, or one too small for a single cell, is refused.
     */
    addScreen(input: NewScreen): string {
      const cfg = state.config
      if (!cfg) return ''
      if (input.kind === 'device') {
        const vp = input.viewport
        const g = vp ? deviceGrid(vp.width, vp.height, DEVICE_NAV_HEIGHT) : null
        if (!vp || !g || !(g.cols >= 1) || !(g.rows >= 1)) { state.toast = t('admin.store.badViewport'); return '' }
      }
      const name = input.name.trim().slice(0, SCREEN_NAME_MAX) || t('admin.store.newScreen')
      const id = freeScreenId(name, cfg.screens.map((x) => x.id))
      const display: ScreenDisplay = input.kind === 'device' && input.viewport
        ? {
          ...deviceGrid(input.viewport.width, input.viewport.height, DEVICE_NAV_HEIGHT),
          cell: DEVICE_CELL, navHeight: DEVICE_NAV_HEIGHT, autoCycleSeconds: 0,
          viewport: { ...input.viewport },
          ...(input.orientation ? { orientation: input.orientation } : {}),
        }
        : { cols: EDGE_COLS, rows: ROWS_BY_NAV_HEIGHT[DEFAULT_NAV_HEIGHT], cell: EDGE_CELL, autoCycleSeconds: 0 }
      display.cols = Math.max(1, display.cols)
      display.rows = Math.max(1, display.rows)
      const from = input.prefill ? cfg.screens.find((x) => x.id === input.prefill!.from) : undefined
      if (from) {
        for (const key of LOOK_KEYS) {
          if (from.display[key] !== undefined) (display as unknown as Record<string, unknown>)[key] = clone(from.display[key])
        }
      }
      const seen = new Set<string>()
      const pages: Page[] = []
      for (const p of input.prefill?.pages ?? []) {
        const items = p.items.filter((x) => cfg.widgets[x.instanceId] && !seen.has(x.instanceId))
        for (const x of items) seen.add(x.instanceId)
        pages.push({ id: freePageId(pages, p.id), name: p.name, items: items.map((x) => ({ ...x })) })
      }
      if (!pages.length) pages.push({ id: freePageId(pages), name: t('admin.store.newPage'), items: [] })
      const added: Screen = { id, name, kind: input.kind, display, nav: [], pages }
      for (const item of input.prefill?.nav ?? []) {
        const widget = cfg.widgets[item.instanceId]
        if (!widget || seen.has(item.instanceId) || added.nav.length >= MAX_NAV_WIDGETS) continue
        const manifest = state.manifests[widget.widgetId]
        const width = compactWidth(manifest, mergeSettings(manifest, widget.settings))
        if (!width || !navHasRoom(added, cfg.widgets, state.manifests, width, item.slot)) continue
        seen.add(item.instanceId)
        added.nav.push({ ...item })
      }
      apply((c) => {
        c.screens.push(added)
        state.screenId = id
        state.pageIndex = 0
        state.selectedId = null
      })
      return id
    },

    renameScreen(id: string, name: string): void {
      const next = name.trim().slice(0, SCREEN_NAME_MAX)
      const scr = state.config?.screens.find((x) => x.id === id)
      if (!scr || !next || next === scr.name) return
      apply((c) => { c.screens.find((x) => x.id === id)!.name = next })
    },

    /** The widgets that screen alone showed are deleted with it. The last screen stays. */
    removeScreen(id: string): void {
      const cfg = state.config
      if (!cfg?.screens.some((x) => x.id === id)) return
      if (cfg.screens.length <= 1) { state.toast = t('admin.store.lastScreen'); return }
      apply((c) => {
        const i = c.screens.findIndex((x) => x.id === id)
        const [removed] = c.screens.splice(i, 1)
        dropUnplaced(c, [...removed.nav.map((x) => x.instanceId), ...removed.pages.flatMap((p) => p.items.map((x) => x.instanceId))])
        if (state.screenId === id) { state.screenId = ''; state.pageIndex = 0; state.selectedId = null }
      })
    },

    /**
     * The navigation bar only draws widgets whose manifest declares a compact rendering, and it
     * holds a handful at most — the server refuses anything else, so both are checked here and
     * reported as a toast rather than as a failed save. A new widget joins the left cluster; the
     * Screen tab moves it to the right one afterwards.
     */
    addNavWidget(widgetId: string): void {
      const manifest = state.manifests[widgetId]
      if (!manifest) { state.toast = t('admin.store.unknownWidget', { id: widgetId }); return }
      if (!manifest.compact) { state.toast = t('admin.store.notCompact', { id: widgetId }); return }
      const scr = screen.value
      if (!scr) return
      // The wider cluster sets both side tracks, keeping the page dots or names centred and visible.
      const width = compactWidth(manifest, mergeSettings(manifest, {}))
      if (scr.nav.length >= MAX_NAV_WIDGETS || !navHasRoom(scr, state.config!.widgets, state.manifests, width)) {
        state.toast = t('admin.store.navFull', { id: pick(manifest.name) || widgetId })
        return
      }
      apply((c) => {
        const instanceId = freeInstanceId(c, widgetId)
        c.widgets[instanceId] = { widgetId, showTitle: true, settings: {} }
        here(c).nav.push({ instanceId, slot: 'left' })
      })
    },

    /** The bar's own trash button: the same as removing a tile from this screen. */
    removeNavWidget(instanceId: string): void {
      store.removeFromScreen(instanceId)
    },

    /**
     * Reordering happens within a cluster: a widget swaps places with its neighbour on the same
     * side, whatever sits between them in the stored list. At either end of its own side it is
     * a no-op rather than a jump across the dots.
     */
    moveNavWidget(instanceId: string, delta: number): void {
      const list = screen.value?.nav ?? []
      const current = list.find((w) => w.instanceId === instanceId)
      if (!current) return
      const sameSide = list.filter((w) => w.slot === current.slot)
      const at = sameSide.indexOf(current)
      const to = at + delta
      if (to < 0 || to >= sameSide.length) return
      const i = list.indexOf(current)
      const j = list.indexOf(sameSide[to])
      apply((c) => {
        const nav = here(c).nav
        const moved = nav[i]
        nav[i] = nav[j]
        nav[j] = moved
      })
    },

    /**
     * `slot` and `popup` belong to this screen's bar entry; `settings` to the shared widget. A
     * change that widens this bar's wider cluster past its room is refused; one that does not is
     * let through even on a bar already over the limit, so an old over-full bar stays editable.
     * Other screens showing the widget are the server's to check, at save.
     */
    updateNavWidget(instanceId: string, patch: NavWidgetPatch): void {
      const { settings, ...itemPatch } = patch
      const cfg = state.config
      const scr = screen.value
      const current = scr?.nav.find((x) => x.instanceId === instanceId)
      if (!cfg || !scr || !current) return
      const widget = cfg.widgets[instanceId]
      const candidate: Screen = {
        ...scr, nav: scr.nav.map((x) => (x.instanceId === instanceId ? { ...x, ...itemPatch } : x)),
      }
      const candidateWidgets = widget && settings !== undefined
        ? { ...cfg.widgets, [instanceId]: { ...widget, settings } }
        : cfg.widgets
      const growsWiderSide = navWiderClusterWidth(candidate, candidateWidgets, state.manifests)
        > navWiderClusterWidth(scr, cfg.widgets, state.manifests)
      if (growsWiderSide && !navHasRoom(candidate, candidateWidgets, state.manifests, 0)) {
        const manifest = widget ? state.manifests[widget.widgetId] : undefined
        state.toast = t('admin.store.navFull', { id: pick(manifest?.name) || widget?.widgetId || instanceId })
        return
      }
      apply((c) => {
        const item = here(c).nav.find((x) => x.instanceId === instanceId)
        if (item && Object.keys(itemPatch).length) patchInto(item as unknown as Record<string, unknown>, itemPatch)
        const widget = c.widgets[instanceId]
        if (widget && settings !== undefined) widget.settings = settings
      })
    },
  }

  return store
}

let singleton: AdminStore | null = null

/** The admin's single store, wired to the real HTTP api and the `config` WebSocket channel. */
export function useAdminStore(): AdminStore {
  if (!singleton) {
    singleton = createAdminStore({
      api: realApi,
      subscribeConfig: (cb) => useSocket().subscribe('config', (data) => cb(data as Config)),
    })
  }
  return singleton
}
