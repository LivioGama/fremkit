<script setup lang="ts">
/**
 * Which screen the editor works on, above the canvas: a segmented control up to three screens, a
 * menu beyond, and "+ Add a screen". Each screen shows its name and an icon for its kind.
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { useI18n } from '../shared/i18n'
import type { Screen } from '../shared/types'
import AddScreenDialog from './AddScreenDialog.vue'
import { useAdminStore } from './store'

/** Beyond this many screens the row would crowd the canvas header, so it becomes a menu. */
const SEGMENTED_MAX = 3

const s = useAdminStore()
const { t } = useI18n()

const screens = computed<Screen[]>(() => s.state.config?.screens ?? [])
const current = computed(() => s.screen.value)
const adding = ref(false)
const menuOpen = ref(false)
const menu = ref<HTMLElement>()

const iconOf = (x: Screen): string => (x.kind === 'edge' ? 'monitor' : 'tablet')

function choose(id: string): void {
  s.selectScreen(id)
  menuOpen.value = false
}

/** The menu closes on a press anywhere outside it, and on Escape. */
function onOutside(e: PointerEvent): void {
  if (menu.value && !menu.value.contains(e.target as Node)) menuOpen.value = false
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') menuOpen.value = false
}
watch(menuOpen, (open) => {
  if (open) {
    window.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('keydown', onKey)
  } else {
    window.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('keydown', onKey)
  }
})
onUnmounted(() => {
  window.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <nav class="screens" :aria-label="t('admin.screens.aria')">
    <div v-if="screens.length <= SEGMENTED_MAX" class="seg" role="tablist">
      <button v-for="x in screens" :key="x.id" type="button" role="tab" :aria-selected="x.id === current?.id"
        :class="{ on: x.id === current?.id }" :title="t(`admin.screens.kind.${x.kind}`)" @click="choose(x.id)">
        <BaseIcon :name="iconOf(x)" :size="16" /><span class="name">{{ x.name }}</span>
      </button>
    </div>
    <div v-else ref="menu" class="menu">
      <button type="button" class="trigger" aria-haspopup="listbox" :aria-expanded="menuOpen"
        :title="t('admin.screens.menu')" @click="menuOpen = !menuOpen">
        <BaseIcon v-if="current" :name="iconOf(current)" :size="16" /><span class="name">{{ current?.name }}</span>
        <BaseIcon name="chevron-down" :size="16" />
      </button>
      <ul v-if="menuOpen" class="list" role="listbox">
        <li v-for="x in screens" :key="x.id" role="option" :aria-selected="x.id === current?.id">
          <button type="button" :class="{ on: x.id === current?.id }" @click="choose(x.id)">
            <BaseIcon :name="iconOf(x)" :size="16" /><span class="name">{{ x.name }}</span>
          </button>
        </li>
      </ul>
    </div>
    <button type="button" class="add" @click="adding = true">{{ t('admin.screens.add') }}</button>
    <AddScreenDialog v-if="adding" @close="adding = false" />
  </nav>
</template>

<style scoped>
.screens { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4) 0; }
.seg { display: flex; gap: 2px; padding: 2px; min-width: 0; background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }
button { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 44px; min-width: 44px;
  font: inherit; font-size: var(--fs-sm); cursor: pointer; padding: 0 var(--space-3); color: var(--text-muted);
  background: transparent; border: 0; border-radius: 6px; }
button:hover { color: var(--text); }
.seg button.on, .list button.on { background: var(--accent); color: var(--on-accent); }
.name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu { position: relative; }
.trigger { background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }
.list { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 100%; margin: 0; padding: 4px;
  list-style: none; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  box-shadow: var(--shadow); }
.list button { width: 100%; }
.add { border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); }
.add:hover { background: var(--surface-2); }
</style>
