<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide } from 'vue'
import { useI18n } from '../shared/i18n'
import { useAdminStore } from './store'
import { widgetDelete, widgetDeleteKey } from './widgetDelete'
import Sidebar from './Sidebar.vue'
import Canvas from './Canvas.vue'
import Inspector from './Inspector.vue'
import TopBar from './TopBar.vue'
import BaseToast from '../shared/ui/BaseToast.vue'
import BaseModal from '../shared/ui/BaseModal.vue'
import ScreenInspector from './ScreenInspector.vue'
import ConnectionsInspector from './ConnectionsInspector.vue'
import MarketplacePanel from './MarketplacePanel.vue'
import WidgetAbout from './WidgetAbout.vue'
import ContextMenu from '../shared/ui/ContextMenu.vue'
import { fits, moveRect, resizeRect } from './layout'
import { useConfigTheme } from '../shared/theme'
import { SCREEN_ID } from '../shared/useWidgetBridge'
import { onWidgetReload } from '../shared/widgetDev'

const s = useAdminStore()
const { t } = useI18n()
// Previews are told the screen being edited, as the dashboard tells its tiles (`Fremkit.screen`).
provide(SCREEN_ID, () => s.screen.value?.id)
// The editor wears the theme it edits, so a tile looks here like it does on the screen.
useConfigTheme(computed(() => s.state.config))

/** True while the user is typing: shortcuts must not steal those keys. */
function inField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
}

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) s.redo()
    else s.undo()
    return
  }
  if (inField(e.target)) return
  const inst = s.selected.value
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault()
    if (inst) s.duplicateWidget(inst.instanceId)
    return
  }
  // ⌘C and ⌘V work on the editor's own widget clipboard, but never over text the user has
  // selected on the page: that copy is the browser's.
  if (mod && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'v') && s.state.mode === 'edit') {
    if (hasTextSelection()) return
    if (e.key.toLowerCase() === 'c') {
      if (!inst) return
      e.preventDefault()
      s.copyWidget(inst.instanceId)
    } else if (s.state.clipboard) {
      e.preventDefault()
      s.pasteWidget()
    }
    return
  }
  if (!inst || s.state.mode !== 'edit') return
  if (e.key === 'Escape') { s.select(null); return }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    // Off this screen only: done at once, undo covers it. On its last screen the widget itself
    // goes, so the key arms the inspector's confirmation and a second press confirms it.
    const id = inst.instanceId
    if (!s.isLastPlace(id)) s.removeFromScreen(id)
    else widgetDelete.ask(widgetDeleteKey(id), () => s.removeFromScreen(id))
    return
  }
  const delta = ARROWS[e.key]
  if (!delta) return
  e.preventDefault()
  // A locked tile stays where it is, whatever moves it.
  if (inst.locked) return
  const start = { x: inst.x, y: inst.y, w: inst.w, h: inst.h }
  const min = s.state.manifests[inst.widgetId]?.minSize ?? [1, 1]
  // Shift resizes from the south-east corner, a bare arrow moves the whole widget.
  const next = e.shiftKey
    ? resizeRect(start, 'se', delta[0], delta[1], min, s.grid.value)
    : moveRect(start, delta[0], delta[1], s.grid.value)
  if (fits(next, s.grid.value, s.others(inst.instanceId))) s.updateInstance(inst.instanceId, next)
}

/** True when the user has selected some text on the page, which ⌘C must copy as usual. */
function hasTextSelection(): boolean {
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed && sel.toString().trim() !== ''
}

/**
 * A press outside a field takes the keyboard back. The edit overlay preventDefaults and stops
 * its own pointerdown to start a drag, so the browser never moves focus by itself and the last
 * edited input would otherwise keep swallowing every shortcut. Hence the capture phase: the
 * overlay's stopPropagation() would hide a bubbling listener from these presses.
 */
function onPointerDown(e: PointerEvent): void {
  if (inField(e.target)) return
  const active = document.activeElement
  if (active instanceof HTMLElement && inField(active)) active.blur()
}

// A widget's manifest was saved while it is being written: the previews wait for this catalogue.
const offReload = onWidgetReload((reload) => { if (reload.manifest) void s.rescan() })

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('pointerdown', onPointerDown, true)
  void s.load()
})
onUnmounted(() => {
  offReload()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('pointerdown', onPointerDown, true)
  void s.flush()
})
</script>

<template>
  <div class="admin" v-if="s.state.config">
    <TopBar />
    <main>
      <Sidebar />
      <Canvas />
      <Inspector />
    </main>
    <BaseModal v-if="s.state.modal === 'screen'" :title="t('admin.tabs.screen')"
      :height="920" :close-label="t('common.close')" @close="s.closeModal()">
      <ScreenInspector />
    </BaseModal>
    <BaseModal v-else-if="s.state.modal === 'connections'" :title="t('admin.tabs.connections')"
      :close-label="t('common.close')" @close="s.closeModal()">
      <ConnectionsInspector />
    </BaseModal>
    <BaseModal v-else-if="s.state.modal === 'marketplace'" :title="t('admin.tabs.marketplace')"
      :width="720" :height="840" :close-label="t('common.close')" @close="s.closeModal()">
      <MarketplacePanel />
    </BaseModal>
    <BaseModal v-else-if="s.state.modal === 'about'" :title="t('admin.about.title')"
      :width="480" :close-label="t('common.close')" @close="s.closeModal()">
      <WidgetAbout :instance-id="s.state.aboutId" />
    </BaseModal>
    <ContextMenu />
    <BaseToast v-if="s.state.toast" :message="s.state.toast" @close="s.dismissToast()" />
  </div>
  <p v-else class="loading">{{ t('common.loading') }}</p>
</template>

<style scoped>
.admin { height: 100vh; display: flex; flex-direction: column; background: var(--bg); }
main { flex: 1; min-height: 0; display: flex; }
.loading { padding: var(--space-4); color: var(--text-muted); }
</style>
