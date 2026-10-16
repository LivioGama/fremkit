<script setup lang="ts">
/**
 * Adds a screen: its name, its kind and, for a device, its size; optionally pre-filled from an
 * existing screen. A pre-fill goes through a preview — page count, the widgets left out by name,
 * a small drawing of each page — and nothing is saved before Accept.
 */
import { computed, ref } from 'vue'
import BaseModal from '../shared/ui/BaseModal.vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import PageView from '../dashboard/PageView.vue'
import { pick, useI18n } from '../shared/i18n'
import { DEVICE_CELL, DEVICE_NAV_HEIGHT, deviceGrid } from '../shared/screens'
import { DEFAULT_NAV_HEIGHT, ROWS_BY_NAV_HEIGHT, type Display, type Screen } from '../shared/types'
import { arrangeInto, type Arrangement } from './arrange'
import { useAdminStore } from './store'

const emit = defineEmits<{ close: [] }>()
const s = useAdminStore()
const { t } = useI18n()

/**
 * Device sizes offered, in CSS px (points) in the orientation they name, as each iPad reports them
 * in its standard display mode. "More Space" reports more; a paired device reports its own size.
 */
const PRESETS = [
  { id: 'ipadPro13Landscape', width: 1376, height: 1032 },
  { id: 'ipadPro13Portrait', width: 1032, height: 1376 },
  { id: 'ipadPro11Landscape', width: 1210, height: 834 },
  { id: 'ipadPro11Portrait', width: 834, height: 1210 },
  { id: 'ipadAir13Landscape', width: 1366, height: 1024 },
  { id: 'ipadAir13Portrait', width: 1024, height: 1366 },
  { id: 'ipadAir11Landscape', width: 1180, height: 820 },
  { id: 'ipadAir11Portrait', width: 820, height: 1180 },
] as const
const CUSTOM = 'custom'
/** The Edge's grid, as `addScreen` builds it. */
const EDGE_GRID = { cols: 64, rows: ROWS_BY_NAV_HEIGHT[DEFAULT_NAV_HEIGHT] }
/** Width of one page drawing in the preview, in CSS px. */
const THUMB_WIDTH = 240

const name = ref('')
const kind = ref<'edge' | 'device'>('device')
const preset = ref<string>(PRESETS[0].id)
const width = ref<number>(PRESETS[0].width)
const height = ref<number>(PRESETS[0].height)
const from = ref('')
const step = ref<'form' | 'preview'>('form')

const screens = computed<Screen[]>(() => s.state.config?.screens ?? [])
const source = computed(() => screens.value.find((x) => x.id === from.value) ?? null)

const viewport = computed(() => {
  const p = PRESETS.find((x) => x.id === preset.value)
  return p ? { width: p.width, height: p.height } : { width: width.value, height: height.value }
})
const grid = computed(() => {
  if (kind.value === 'edge') return EDGE_GRID
  const { width: w, height: h } = viewport.value
  if (!Number.isInteger(w) || !Number.isInteger(h)) return { cols: 0, rows: 0 }
  // The rows `addScreen` will give it, under the slim bar a device screen starts with.
  return deviceGrid(w, h, DEVICE_NAV_HEIGHT)
})
const sizeOk = computed(() => grid.value.cols >= 1 && grid.value.rows >= 1)
const defaultName = computed(() => (kind.value === 'edge'
  ? t('admin.screens.kind.edge')
  : preset.value === CUSTOM ? t('admin.screens.kind.device') : t(`admin.screens.preset.${preset.value}`)))

const arrangement = computed<Arrangement | null>(() => {
  const cfg = s.state.config
  if (!cfg || !source.value || !sizeOk.value) return null
  return arrangeInto(source.value, { ...grid.value, navCols: grid.value.cols }, cfg.widgets, s.state.manifests)
})

/** How a widget is named to the user: its title, else its manifest's name, else its widget id. */
function nameOf(instanceId: string): string {
  const w = s.state.config?.widgets[instanceId]
  if (!w) return instanceId
  return w.title?.trim() || pick(s.state.manifests[w.widgetId]?.name) || w.widgetId
}
const names = (ids: string[]): string => ids.map(nameOf).join(', ')

/** The pages drawn the way the new screen will show them: its grid, the look it takes from the source. */
const previewDisplay = computed<Display>(() => ({
  ...grid.value, cell: DEVICE_CELL, autoCycleSeconds: 0,
  ...(kind.value === 'device' ? { navHeight: DEVICE_NAV_HEIGHT } : {}),
  ...(source.value?.display.background ? { background: source.value.display.background } : {}),
}))
const thumbScale = computed(() => THUMB_WIDTH / (Math.max(1, grid.value.cols) * DEVICE_CELL))

function orientation(): 'landscape' | 'portrait' {
  return viewport.value.width >= viewport.value.height ? 'landscape' : 'portrait'
}

function submit(): void {
  if (!sizeOk.value) return
  if (source.value) { step.value = 'preview'; return }
  create()
}

function create(): void {
  const a = arrangement.value
  const id = s.addScreen({
    name: name.value.trim() || defaultName.value,
    kind: kind.value,
    ...(kind.value === 'device' ? { viewport: { ...viewport.value }, orientation: orientation() } : {}),
    prefill: source.value && a ? { from: source.value.id, pages: a.pages, nav: a.nav } : null,
  })
  if (id) emit('close')
}
</script>

<template>
  <BaseModal :title="t('admin.screens.dialog.title')" :width="step === 'preview' ? 640 : 480"
    :close-label="t('common.close')" @close="emit('close')">
    <form v-if="step === 'form'" class="form" @submit.prevent="submit">
      <BaseField :label="t('admin.screens.dialog.name')">
        <BaseInput v-model="name" :placeholder="defaultName" />
      </BaseField>

      <BaseField :label="t('admin.screens.dialog.kind')">
        <div class="choice" role="radiogroup">
          <button v-for="k in (['device', 'edge'] as const)" :key="k" type="button" role="radio"
            :aria-checked="kind === k" :class="{ on: kind === k }" @click="kind = k">
            <BaseIcon :name="k === 'edge' ? 'monitor' : 'tablet'" :size="16" />{{ t(`admin.screens.kind.${k}`) }}
          </button>
        </div>
      </BaseField>
      <p v-if="kind === 'edge'" class="note"><BaseIcon name="alert-triangle" :size="16" />{{ t('admin.screens.edgeNote') }}</p>

      <template v-if="kind === 'device'">
        <BaseField :label="t('admin.screens.dialog.size')">
          <select v-model="preset" class="select">
            <option v-for="p in PRESETS" :key="p.id" :value="p.id">{{ t(`admin.screens.preset.${p.id}`) }} — {{ p.width }} × {{ p.height }}</option>
            <option :value="CUSTOM">{{ t('admin.screens.dialog.custom') }}</option>
          </select>
        </BaseField>
        <p class="hint">{{ t('admin.screens.dialog.sizeHint') }}</p>
        <div v-if="preset === CUSTOM" class="row">
          <BaseField :label="t('admin.screens.dialog.width')">
            <BaseInput :model-value="width" type="number" :min="40" :invalid="!sizeOk" @update:model-value="width = Number($event)" />
          </BaseField>
          <BaseField :label="t('admin.screens.dialog.height')">
            <BaseInput :model-value="height" type="number" :min="120" :invalid="!sizeOk" @update:model-value="height = Number($event)" />
          </BaseField>
        </div>
        <p v-if="sizeOk" class="hint">{{ t('admin.screens.dialog.grid', grid) }} {{ t('admin.screens.dialog.deviceHint') }}</p>
        <p v-else class="hint bad" role="alert">{{ t('admin.screens.dialog.badSize') }}</p>
      </template>

      <BaseField :label="t('admin.screens.dialog.prefill')">
        <select v-model="from" class="select">
          <option value="">{{ t('admin.screens.dialog.empty') }}</option>
          <option v-for="x in screens" :key="x.id" :value="x.id">{{ x.name }}</option>
        </select>
      </BaseField>

      <div class="actions">
        <BaseButton @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
        <BaseButton variant="primary" :disabled="!sizeOk" @click="submit">
          {{ source ? t('admin.screens.dialog.preview') : t('admin.screens.dialog.add') }}
        </BaseButton>
      </div>
    </form>

    <div v-else-if="arrangement && source" class="preview">
      <p class="summary">{{ t('admin.screens.preview.pages', { count: arrangement.pages.length, ...grid }) }}</p>
      <p class="line">{{ t('admin.screens.preview.look', { name: source.name }) }}</p>
      <p v-if="arrangement.leftOut.length" class="line warn" data-test="left-out">
        <BaseIcon name="alert-triangle" :size="16" />{{ t('admin.screens.preview.leftOut', { names: names(arrangement.leftOut) }) }}
      </p>
      <p v-if="arrangement.navToTiles.length" class="line">
        {{ t('admin.screens.preview.navToTiles', { names: names(arrangement.navToTiles) }) }}
      </p>
      <p v-if="!arrangement.leftOut.length" class="line">{{ t('admin.screens.preview.nothingLeftOut') }}</p>

      <ul class="thumbs">
        <li v-for="p in arrangement.pages" :key="p.id">
          <div class="thumb" :style="{ width: grid.cols * DEVICE_CELL * thumbScale + 'px', height: grid.rows * DEVICE_CELL * thumbScale + 'px' }">
            <div class="scaled" :style="{ width: grid.cols * DEVICE_CELL + 'px', transform: `scale(${thumbScale})` }">
              <PageView :page="p" :config="s.state.config!" :display="previewDisplay" :manifests="s.state.manifests" edit />
            </div>
          </div>
          <span class="caption">{{ p.name }}</span>
        </li>
      </ul>

      <div class="actions">
        <BaseButton @click="step = 'form'">{{ t('admin.screens.preview.back') }}</BaseButton>
        <BaseButton variant="primary" @click="create">{{ t('admin.screens.preview.accept') }}</BaseButton>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.form, .preview { display: flex; flex-direction: column; }
.choice { display: flex; gap: var(--space-2); }
.choice button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
  min-height: 44px; font: inherit; font-size: var(--fs-sm); cursor: pointer; color: var(--text-muted);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }
.choice button.on { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.select { width: 100%; min-height: 44px; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.row { display: flex; gap: var(--space-3); }
.row > * { flex: 1; }
.note { display: flex; gap: var(--space-2); align-items: flex-start; margin: 0 0 var(--space-3);
  font-size: var(--fs-sm); color: var(--text-muted); }
.hint { margin: 0 0 var(--space-3); font-size: var(--fs-xs); color: var(--text-dim); }
.hint.bad { color: var(--danger); }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }
.actions :deep(button) { min-height: 44px; }
.summary { margin: 0 0 var(--space-2); font-weight: 600; }
.line { display: flex; gap: var(--space-2); align-items: flex-start; margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.line.warn { color: var(--text); }
.thumbs { list-style: none; margin: var(--space-2) 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-3); }
.thumbs li { display: flex; flex-direction: column; gap: var(--space-1); }
.thumb { position: relative; overflow: hidden; pointer-events: none; background: var(--bg);
  border: 1px solid var(--border); border-radius: var(--radius-sm); }
.scaled { transform-origin: top left; }
.caption { font-size: var(--fs-xs); color: var(--text-muted); }
</style>
