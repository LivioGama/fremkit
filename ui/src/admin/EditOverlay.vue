<script setup lang="ts">
/**
 * Mouse capture layer over the widget area in edit mode: grid guides, selection,
 * eight resize handles, and a snapped ghost that turns red when the drop is refused.
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import BaseChip from '../shared/ui/BaseChip.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { pick, useI18n } from '../shared/i18n'
import { screensShowing, tileOf } from '../shared/screens'
import { DND_EXISTING_TYPE, DND_TYPE, useAdminStore } from './store'
import { fitAround, fits, moveRect, resizeRect, snapPoint, type Handle, type Rect } from './layout'
import { openContextMenu } from '../shared/ui/contextMenu'
import { canvasMenu, widgetMenu } from './canvasMenu'
import { editorFocus } from './editorFocus'
import { describeProblem } from './health'
import { useHealth } from './useHealth'

const props = defineProps<{ scale: number }>()
const s = useAdminStore()
const { t } = useI18n()
const root = ref<HTMLElement>()

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const cell = computed(() => s.screen.value!.display.cell)
/** This page's tiles, each joined with its shared widget for its name and manifest. */
const widgets = computed(() => (s.page.value?.items ?? []).map((p) => tileOf(s.state.config!, p)))
/** How many screens show each tile's widget; more than one and the tile wears the count. */
const shownOn = (instanceId: string): number => screensShowing(s.state.config!, instanceId).length
const boardH = computed(() => s.grid.value.rows * cell.value)

const health = useHealth()
/** The menus lead with the fix of a widget that is not well. */
const menuUi = { ...editorFocus, fix: health.fix, update: health.update }
/**
 * The health badge is drawn inside the scaled board, so it is sized in the board's pixels from
 * the size it should have on screen: a fixed 12 px here is 5 px once the Edge's 2560 px are fitted
 * into the editor's column, which is how the lock icon ended up unreadable.
 */
const BADGE_SCREEN_PX = 20
const badgeSize = computed(() => BADGE_SCREEN_PX / (props.scale || 1))
/** The `n`th badge from the tile's bottom-left corner: the problem first, the update beside it. */
const badgeStyle = (n: number) => {
  const k = props.scale || 1
  const size = badgeSize.value
  return {
    width: size + 'px', height: size + 'px', left: 6 / k + n * (size + 4 / k) + 'px', bottom: 6 / k + 'px',
    fontSize: size * 0.68 + 'px', borderWidth: 2 / k + 'px',
  }
}
/** The problem badge's tooltip: every problem, one per line. */
const healthTitle = (instanceId: string): string => health.of(instanceId).problems.map(describeProblem).join('\n')
/** The update badge's tooltip. */
function updateTitle(instanceId: string): string {
  const v = health.of(instanceId).update?.version
  return v ? t('admin.health.update.available', { version: v }) : t('admin.health.update.badge')
}

interface Drag { kind: 'move' | 'resize' | 'create'; instanceId: string; widgetId: string; start: Rect; handle: Handle; min: [number, number]; ox: number; oy: number }
const drag = ref<Drag | null>(null)
const ghost = ref<Rect | null>(null)
const ghostOk = ref(true)
/** The element holding the pointer capture, so an aborted drag can hand it back. */
let captured: { el: HTMLElement; pointerId: number } | null = null

const boxStyle = (r: Rect) => ({
  left: r.x * cell.value + 'px', top: r.y * cell.value + 'px',
  width: r.w * cell.value + 'px', height: r.h * cell.value + 'px',
})
const gridStyle = computed(() => ({
  backgroundSize: `${cell.value}px ${cell.value}px, ${cell.value}px ${cell.value}px, ${cell.value * 4}px ${cell.value * 4}px, ${cell.value * 4}px ${cell.value * 4}px`,
}))

function minOf(widgetId: string): [number, number] {
  return s.state.manifests[widgetId]?.minSize ?? [1, 1]
}
function labelOf(instanceId: string): string {
  const w = widgets.value.find((x) => x.instanceId === instanceId)
  if (!w) return ''
  return `${w.title?.trim() || pick(s.state.manifests[w.widgetId]?.name) || w.widgetId} · ${w.w}×${w.h}`
}
function iconOf(instanceId: string): string {
  const w = widgets.value.find((x) => x.instanceId === instanceId)
  return s.state.manifests[w?.widgetId ?? '']?.icon ?? 'layout-grid'
}

/** Pointer position in grid cells; the board is CSS-scaled, so divide the offset by the scale. */
function cellAt(e: PointerEvent | DragEvent): { x: number; y: number } {
  const box = root.value!.getBoundingClientRect()
  return snapPoint(e.clientX - box.left, e.clientY - box.top, cell.value, props.scale)
}

function begin(e: PointerEvent, instanceId: string, kind: 'move' | 'resize', handle: Handle): void {
  const inst = widgets.value.find((w) => w.instanceId === instanceId)
  if (!inst) return
  s.select(instanceId)
  // A secondary press (right button, or Control-click on a Mac) is a context menu, not a drag;
  // a locked tile is selected but never dragged nor resized.
  if (e.button !== 0 || e.ctrlKey || inst.locked) { e.stopPropagation(); return }
  const p = cellAt(e)
  drag.value = {
    kind, instanceId, widgetId: inst.widgetId, handle,
    start: { x: inst.x, y: inst.y, w: inst.w, h: inst.h },
    min: minOf(inst.widgetId), ox: p.x, oy: p.y,
  }
  ghost.value = { ...drag.value.start }
  ghostOk.value = true
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  captured = { el, pointerId: e.pointerId }
  e.preventDefault()
  e.stopPropagation()
}

function onPointerMove(e: PointerEvent): void {
  const d = drag.value
  if (!d) return
  const p = cellAt(e)
  const next = d.kind === 'move'
    ? moveRect(d.start, p.x - d.ox, p.y - d.oy, s.grid.value)
    : resizeRect(d.start, d.handle, p.x - d.ox, p.y - d.oy, d.min, s.grid.value)
  ghost.value = next
  ghostOk.value = fits(next, s.grid.value, s.others(d.instanceId))
}

function onPointerUp(): void {
  const d = drag.value
  const g = ghost.value
  drag.value = null
  ghost.value = null
  captured = null
  if (!d || !g || !ghostOk.value) return
  if (g.x === d.start.x && g.y === d.start.y && g.w === d.start.w && g.h === d.start.h) return
  s.updateInstance(d.instanceId, { x: g.x, y: g.y, w: g.w, h: g.h })
}

function onBackgroundDown(): void {
  s.select(null)
}

/** A right click on a tile selects it, as on the Mac's desktop, then opens its menu. */
function onTileMenu(e: MouseEvent, instanceId: string): void {
  s.select(instanceId)
  openContextMenu(e, widgetMenu(s, instanceId, menuUi))
}
function onBackgroundMenu(e: MouseEvent): void {
  s.select(null)
  openContextMenu(e, canvasMenu(s, menuUi))
}

/**
 * Safety net: losing the window mid-drag means no pointerup ever arrives, which would leave
 * a ghost stuck on the board and the next click applying a stale move. Drop the drag instead.
 */
function abortDrag(): void {
  if (captured) {
    // The element may already be gone or the capture implicitly released; either is fine.
    try { captured.el.releasePointerCapture(captured.pointerId) } catch { /* nothing to release */ }
    captured = null
  }
  drag.value = null
  ghost.value = null
}
function onVisibilityChange(): void { if (document.hidden) abortDrag() }

onMounted(() => {
  window.addEventListener('blur', abortDrag)
  document.addEventListener('visibilitychange', onVisibilityChange)
})
onBeforeUnmount(() => {
  window.removeEventListener('blur', abortDrag)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

// --- dropping a card from the library ---
/** The manifest of what is being dragged: a library card, or a widget shown on another screen. */
function draggedManifest(existing: boolean) {
  const id = s.state.dragWidgetId
  if (!id) return undefined
  return s.state.manifests[existing ? s.state.config?.widgets[id]?.widgetId ?? '' : id]
}
const isOurs = (e: DragEvent): boolean =>
  !!e.dataTransfer && (e.dataTransfer.types.includes(DND_TYPE) || e.dataTransfer.types.includes(DND_EXISTING_TYPE))

function onDragOver(e: DragEvent): void {
  // Only our own library cards may drop here: a native drag of text, a link or an image
  // carries neither type and must pass straight through.
  if (!isOurs(e)) return
  const manifest = draggedManifest(e.dataTransfer!.types.includes(DND_EXISTING_TYPE))
  if (!manifest) return
  e.preventDefault()
  // The ghost shrinks towards the widget's minimum when the default size does not fit here.
  const next = fitAround(cellAt(e), manifest.defaultSize, manifest.minSize, s.grid.value, s.others())
  ghost.value = next
  ghostOk.value = fits(next, s.grid.value, s.others())
}

function onDrop(e: DragEvent): void {
  if (!isOurs(e)) return
  e.preventDefault()
  const existing = e.dataTransfer!.types.includes(DND_EXISTING_TYPE)
  const id = s.state.dragWidgetId
  const g = ghost.value
  ghost.value = null
  s.setDragWidget(null)
  if (!id || !g || !ghostOk.value) return
  if (existing) s.placeExisting(id, g)
  else s.placeWidget(id, g)
}

function onDragLeave(): void { ghost.value = null }
</script>

<template>
  <div
    class="overlay" ref="root" :style="[{ height: boardH + 'px' }, gridStyle]"
    @pointerdown="onBackgroundDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp"
    @dragover="onDragOver" @drop="onDrop" @dragleave="onDragLeave"
    @contextmenu="onBackgroundMenu"
  >
    <div
      v-for="w in widgets" :key="w.instanceId" class="hit" data-test="tile" :data-instance-id="w.instanceId"
      :class="{ selected: w.instanceId === s.state.selectedId, locked: w.locked }" :style="boxStyle(w)"
      @pointerdown="begin($event, w.instanceId, 'move', 'se')"
      @contextmenu="onTileMenu($event, w.instanceId)"
    >
      <BaseChip v-if="w.instanceId === s.state.selectedId" tone="accent" class="tag">
        <BaseIcon :name="iconOf(w.instanceId)" :size="14" />{{ labelOf(w.instanceId) }}
      </BaseChip>
      <BaseChip v-if="shownOn(w.instanceId) > 1" class="shared" :title="t('admin.overlay.sharedOn', { n: shownOn(w.instanceId) })">
        <BaseIcon name="monitor" :size="12" />{{ shownOn(w.instanceId) }}
      </BaseChip>
      <span v-if="health.of(w.instanceId).problems.length" class="health" :class="health.of(w.instanceId).level"
        :style="badgeStyle(0)" :title="healthTitle(w.instanceId)" role="img" :aria-label="healthTitle(w.instanceId)" data-health-badge>!</span>
      <!-- An update is news, not a problem: an arrow in the accent, like the library's "↑ version" chip. -->
      <span v-if="health.of(w.instanceId).update" class="health update"
        :style="badgeStyle(health.of(w.instanceId).problems.length ? 1 : 0)" :title="updateTitle(w.instanceId)" role="img"
        :aria-label="updateTitle(w.instanceId)" data-update-badge><BaseIcon name="arrow-up" :size="badgeSize * 0.7" /></span>
      <span v-if="w.locked" class="lock" :title="t('admin.overlay.locked')"><BaseIcon name="lock" :size="12" /></span>
      <span
        v-for="hnd in HANDLES" v-show="w.instanceId === s.state.selectedId && !w.locked" :key="hnd"
        class="handle" :class="hnd" :data-test="`handle-${hnd}`" @pointerdown="begin($event, w.instanceId, 'resize', hnd)"
      />
    </div>
    <div v-if="ghost" class="ghost" :class="{ bad: !ghostOk }" :style="boxStyle(ghost)" />
  </div>
</template>

<style scoped>
.overlay { position: absolute; left: 0; top: 0; right: 0; touch-action: none; user-select: none; z-index: 4;
  background-image:
    linear-gradient(to right, rgba(255, 255, 255, .05) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255, 255, 255, .05) 1px, transparent 1px),
    linear-gradient(to right, rgba(255, 255, 255, .12) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255, 255, 255, .12) 1px, transparent 1px);
}
.hit { position: absolute; box-sizing: border-box; cursor: move; border: 2px solid transparent; border-radius: var(--radius-md); }
.hit.selected { border-color: var(--accent); }
.hit.locked { cursor: default; }
.lock { position: absolute; right: 6px; bottom: 6px; display: inline-flex; padding: 4px; pointer-events: none;
  border-radius: var(--radius-sm); background: var(--surface-3); color: var(--text-muted); }
.health { position: absolute; display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  border-radius: 50%; border-style: solid; border-color: var(--bg); color: #fff; font-weight: 800; line-height: 1;
  font-family: var(--font); box-shadow: 0 0 0 1px rgba(0, 0, 0, .25); cursor: help; }
.health.error { background: var(--danger); }
.health.warning { background: var(--warn); }
.health.update { background: var(--accent); color: var(--on-accent); }
.shared { position: absolute; right: 6px; top: 6px; pointer-events: none; gap: 2px; }
.tag { position: absolute; left: 6px; top: 6px; pointer-events: none; }
.handle { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 3px;
  background: var(--accent); border: 2px solid var(--on-accent); box-sizing: border-box; }
.handle.nw { left: 0; top: 0; cursor: nwse-resize; }
.handle.n { left: 50%; top: 0; cursor: ns-resize; }
.handle.ne { left: 100%; top: 0; cursor: nesw-resize; }
.handle.e { left: 100%; top: 50%; cursor: ew-resize; }
.handle.se { left: 100%; top: 100%; cursor: nwse-resize; }
.handle.s { left: 50%; top: 100%; cursor: ns-resize; }
.handle.sw { left: 0; top: 100%; cursor: nesw-resize; }
.handle.w { left: 0; top: 50%; cursor: ew-resize; }
.ghost { position: absolute; box-sizing: border-box; pointer-events: none; border-radius: var(--radius-md);
  border: 2px dashed var(--ok); background: rgba(47, 179, 107, .18); }
.ghost.bad { border-color: var(--danger); background: rgba(217, 70, 63, .18); }
</style>
