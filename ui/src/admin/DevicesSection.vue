<script setup lang="ts">
/**
 * The Devices section: the switch that opens the remote listener, the pairing code while it is
 * open, one row per paired device, and the two ways to start over.
 *
 * A code is asked for whenever pairing is on and none is on show — on turning it on, on opening
 * the admin while it is on, when the shown one runs out — so the code on screen is always one the
 * server will take. `keyHash` is never shown: a partial hash is no help to compare, and the
 * readable fingerprint comes with the device app.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { renderSVG } from 'uqr'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { useI18n } from '../shared/i18n'
import { useConfirm } from '../shared/useConfirm'
import type { PublicDevice } from '../shared/api'
import type { Screen } from '../shared/types'
import AddScreenDialog from './AddScreenDialog.vue'
import { useDevices } from './devices'
import { useAdminStore } from './store'

const s = useAdminStore()
const { t, locale } = useI18n()
const devices = useDevices()
const confirm = useConfirm()
const { status, offer, error } = devices

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
let release: (() => void) | undefined
onMounted(() => {
  release = devices.watch()
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  release?.()
  if (ticker !== undefined) clearInterval(ticker)
})

const enabled = computed(() => status.value?.enabled ?? false)
/** Pairing is open only once the listener actually runs: the switch alone says nothing yet. */
const live = computed(() => enabled.value && (status.value?.listening ?? false))
const portInUse = computed(() => status.value?.error === 'portInUse')

watch([live, offer], ([isLive, shown]) => {
  if (isLive && !shown) void devices.newCode()
  else if (!isLive && shown) offer.value = null
}, { immediate: true })
/** A code that ran out is replaced, so the one on screen always pairs. */
watch(now, (at) => {
  if (live.value && offer.value && at >= offer.value.expiresAt) void devices.newCode()
})

const qr = computed(() => (offer.value ? renderSVG(offer.value.url, { ecc: 'M', pixelSize: 1 }) : ''))
const countdown = computed(() => {
  if (!offer.value) return ''
  const left = Math.max(0, Math.ceil((offer.value.expiresAt - now.value) / 1000))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
})

const deviceScreens = computed<Screen[]>(() => (s.state.config?.screens ?? []).filter((x) => x.kind === 'device'))
const list = computed<PublicDevice[]>(() => status.value?.devices ?? [])

function when(iso: string | null): string {
  if (!iso) return t('admin.devices.neverSeen')
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso
    : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function pickScreen(device: PublicDevice, value: string): void {
  void devices.attach(device.id, value === '' ? null : value)
}

/** The device a screen is being made for, while its dialog is open. */
const creatingFor = ref<PublicDevice | null>(null)
function onCreated(screenId: string): void {
  const device = creatingFor.value
  if (device) void devices.attach(device.id, screenId)
}
</script>

<template>
  <div class="devices">
    <BaseCheckbox :model-value="enabled" :label="t('admin.devices.enable')"
      @update:model-value="devices.setEnabled($event)" />
    <p class="ro">{{ t('admin.devices.firewall') }}</p>
    <p v-if="portInUse" class="bad" role="alert" data-test="port-in-use">{{ t('admin.devices.portInUse', { port: status?.port ?? '' }) }}</p>

    <div v-if="live && offer" class="pair">
      <!-- The SVG is drawn here from the offer's URL, never taken from the network as markup. -->
      <div class="qr" role="img" :aria-label="t('admin.devices.qr')" v-html="qr" />
      <div class="code">
        <p class="ro">{{ t('admin.devices.scan') }}</p>
        <p class="value mono" data-test="pairing-code">{{ offer.code }}</p>
        <p class="ro">{{ t('admin.devices.expires', { time: countdown }) }}</p>
        <BaseButton @click="devices.newCode()"><BaseIcon name="refresh-cw" :size="16" />{{ t('admin.devices.newCode') }}</BaseButton>
      </div>
    </div>
    <p v-if="live && status?.guessing" class="warn" role="alert">
      <BaseIcon name="alert-triangle" :size="16" />{{ t('admin.devices.guessing') }}
    </p>
    <p v-if="error" class="bad">{{ error }}</p>

    <ul v-if="list.length" class="list">
      <li v-for="d in list" :key="d.id" class="device" data-test="device">
        <div class="head">
          <BaseIcon name="tablet" :size="16" />
          <strong class="name">{{ d.name }}</strong>
          <span class="ro size">{{ t('admin.inspector.screen.viewport.value', d.viewport) }}</span>
        </div>
        <label class="field">
          <span class="ro">{{ t('admin.devices.screen') }}</span>
          <select :value="d.screenId ?? ''" :aria-label="t('admin.devices.screen')"
            @change="pickScreen(d, ($event.target as HTMLSelectElement).value)">
            <option value="">{{ t('admin.devices.noScreen') }}</option>
            <option v-for="x in deviceScreens" :key="x.id" :value="x.id">{{ x.name }}</option>
          </select>
        </label>
        <div v-if="d.screenId === null" class="prompt">
          <span>{{ t('admin.devices.noScreenPrompt') }}</span>
          <BaseButton variant="primary" data-test="create-screen" @click="creatingFor = d">{{ t('admin.devices.createScreen') }}</BaseButton>
        </div>
        <p class="ro">{{ t('admin.devices.pairedAt', { date: when(d.pairedAt) }) }} · {{ t('admin.devices.lastSeen', { date: when(d.lastSeen) }) }}</p>
        <BaseButton variant="danger" @click="confirm.ask(`device:${d.id}`, () => devices.remove(d.id))">
          <template v-if="confirm.armed(`device:${d.id}`)">{{ t('common.confirm') }}</template>
          <template v-else><BaseIcon name="trash-2" :size="16" />{{ t('admin.devices.remove') }}</template>
        </BaseButton>
      </li>
    </ul>
    <p v-else class="ro">{{ t('admin.devices.none') }}</p>

    <div class="row">
      <BaseButton variant="danger" :disabled="!list.length" @click="confirm.ask('devices:all', () => devices.removeAll())">
        {{ confirm.armed('devices:all') ? t('common.confirm') : t('admin.devices.removeAll') }}
      </BaseButton>
      <BaseButton variant="danger" @click="confirm.ask('devices:cert', () => devices.resetCertificate())">
        {{ confirm.armed('devices:cert') ? t('common.confirm') : t('admin.devices.resetCertificate') }}
      </BaseButton>
    </div>
    <p class="ro">{{ t('admin.devices.resetCertificate.hint') }}</p>

    <AddScreenDialog v-if="creatingFor" :device="creatingFor" @created="onCreated" @close="creatingFor = null" />
  </div>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.bad { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--danger); white-space: pre-wrap; }
.warn { display: flex; gap: var(--space-2); align-items: flex-start; margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--danger); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pair { display: flex; gap: var(--space-3); align-items: center; margin-bottom: var(--space-3); }
/* A white quiet zone whatever the theme: a phone camera reads dark modules on light. */
.qr { flex: none; width: 168px; height: 168px; padding: 8px; background: #fff; border-radius: var(--radius-sm); }
.qr :deep(svg) { display: block; width: 100%; height: 100%; }
.code { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
.value { margin: 0 0 var(--space-1); font-size: 1.6em; letter-spacing: .12em; color: var(--text); }
.code :deep(button), .row :deep(button), .device :deep(button) { min-height: 44px; }
.list { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.device { padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.size { margin: 0 0 0 auto; }
.field { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.field .ro { margin: 0; }
.field select { flex: 1; min-width: 0; min-height: 44px; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.prompt { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-2); font-size: var(--fs-sm); }
.row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-2); }
</style>
