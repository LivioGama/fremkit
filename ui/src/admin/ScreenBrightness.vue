<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseRange from '../shared/ui/BaseRange.vue'
import BaseSection from '../shared/ui/BaseSection.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import { useI18n } from '../shared/i18n'
import { api } from '../shared/api'
import { useSocket } from '../shared/socket'
import type { BrightnessSettings, Config, Screen } from '../shared/types'
import { useAdminStore } from './store'

/**
 * The Screen panel's brightness section: the live level of the selected screen, and how it is
 * driven when nobody touches it (day/night, follow the Mac). The live level goes to the
 * `brightness` provider as a command; the settings are saved with the screen like any other
 * setting, undoable. See `server/src/brightness/` for the rules the hints describe.
 */

/** Mirrors `ScreenBrightness` in `server/src/brightness/service.ts`, as far as this panel reads it. */
interface Live {
  available: boolean
  reason?: string
  value: number | null
  target: number | null
  mode: 'manual' | 'day-night' | 'follow-mac' | 'both'
  overridden: boolean
  dayNightProblem?: string
  followProblem?: string
  phase?: { state: string; next?: { at: string; to: 'day' | 'night' } }
  builtin: boolean
  display?: string
}

const s = useAdminStore()
const { t, locale } = useI18n()
const socket = useSocket()

const scr = computed(() => s.screen.value!)
const live = ref<Record<string, Live>>({})
const kiosk = ref<string | null>(null)
const unsubscribe = socket.subscribe('brightness', (data) => {
  const d = data as { kiosk?: string | null; screens?: Record<string, Live> } | null
  live.value = d?.screens ?? {}
  kiosk.value = d?.kiosk ?? null
})
onUnmounted(unsubscribe)

const here = computed<Live | undefined>(() => live.value[scr.value.id])
const level = computed(() => here.value?.value ?? here.value?.target ?? 50)

/** The defaults of `BrightnessSettingsSchema`, for a screen that has never had the key. */
const DEFAULTS: BrightnessSettings = {
  dayNight: { enabled: false, day: 80, night: 30, schedule: 'sun', dayAt: '07:00', nightAt: '21:00', rampMinutes: 20 },
  followMac: { enabled: false, scale: 1, offset: 0 },
}
const b = computed<BrightnessSettings>(() => {
  const own = scr.value.brightness
  return { dayNight: { ...DEFAULTS.dayNight, ...own?.dayNight }, followMac: { ...DEFAULTS.followMac, ...own?.followMac } }
})
const onScreen = (c: Config): Screen => c.screens.find((x) => x.id === scr.value.id)!

function setDayNight(patch: Partial<BrightnessSettings['dayNight']>): void {
  s.apply((c) => {
    const screen = onScreen(c)
    const current = { ...b.value }
    screen.brightness = { ...current, dayNight: { ...current.dayNight, ...patch } }
  })
}
function setFollow(patch: Partial<BrightnessSettings['followMac']>): void {
  s.apply((c) => {
    const screen = onScreen(c)
    const current = { ...b.value }
    screen.brightness = { ...current, followMac: { ...current.followMac, ...patch } }
  })
}

/** A coordinate typed in the field: kept when it is a number in range, refused (toast) otherwise. */
function setCoordinate(key: 'latitude' | 'longitude', raw: string | number): void {
  const limit = key === 'latitude' ? 90 : 180
  const value = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'))
  if (String(raw).trim() === '' ) return setDayNight({ [key]: undefined })
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    s.state.toast = t('brightness.admin.badCoordinate')
    return
  }
  setDayNight({ [key]: Math.round(value * 10000) / 10000 })
}
// The city search: one request when the user presses Search, never as they type.
const placeQuery = ref('')
const places = ref<{ name: string; detail: string; latitude: number; longitude: number }[] | null>(null)
const searching = ref(false)
async function searchPlaces(): Promise<void> {
  const q = placeQuery.value.trim()
  if (q.length < 2 || searching.value) return
  searching.value = true
  try {
    places.value = (await api.searchPlaces(q, locale.value === 'fr' ? 'fr' : 'en')).places
  } catch (err) {
    places.value = null
    s.state.toast = (err as Error).message
  } finally {
    searching.value = false
  }
}
function usePlace(p: { latitude: number; longitude: number }): void {
  setDayNight({ latitude: p.latitude, longitude: p.longitude })
  places.value = null
  placeQuery.value = ''
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
function setClock(key: 'dayAt' | 'nightAt', raw: string | number): void {
  const value = String(raw).trim().replace(/^(\d):/, '0$1:').replace('h', ':')
  if (!CLOCK.test(value)) {
    s.state.toast = t('brightness.admin.badTime')
    return
  }
  setDayNight({ [key]: value })
}
function setRamp(raw: string | number): void {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 120) {
    s.state.toast = t('brightness.admin.badRamp')
    return
  }
  setDayNight({ rampMinutes: value })
}

// The live slider drives the screen as it moves, at most every 100 ms, the last move winning.
let lastSent = 0
let pending: number | null = null
let timer: ReturnType<typeof setTimeout> | null = null
function send(value: number, force = false): void {
  const now = Date.now()
  if (!force && now - lastSent < 100) {
    pending = value
    timer ??= setTimeout(() => { timer = null; if (pending !== null) { const p = pending; pending = null; send(p, true) } }, 100 - (now - lastSent))
    return
  }
  lastSent = now
  pending = null
  socket.command('brightness', 'set', { screen: scr.value.id, value }).catch((err: Error) => { s.state.toast = err.message })
}
function resume(): void {
  socket.command('brightness', 'resume', { screen: scr.value.id }).catch((err: Error) => { s.state.toast = err.message })
}

const SCHEDULES = computed(() => (['sun', 'fixed'] as const).map((value) => ({ value, label: t(`brightness.admin.schedule.${value}`) })))

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString(locale.value === 'fr' ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit' })

const status = computed(() => {
  const l = here.value
  if (!l) return t('brightness.admin.waiting')
  if (!l.available) return t(`brightness.admin.reason.${l.reason ?? 'no-ddc'}`)
  const parts = [t(`brightness.admin.mode.${l.mode}`)]
  if (l.overridden) parts.push(t('brightness.admin.overridden'))
  if (l.phase?.next) parts.push(t(`brightness.admin.next.${l.phase.next.to}`, { time: clock(l.phase.next.at) }))
  return parts.join(' · ')
})
const scalePercent = computed(() => Math.round(b.value.followMac.scale * 100))
</script>

<template>
  <BaseSection id="screen.brightness" :title="t('brightness.admin.title')">
    <BaseField :label="t('brightness.admin.level')" :hint="here?.display ? t('brightness.admin.display', { name: here.display }) : undefined">
      <BaseRange v-if="here?.available" :model-value="level" :aria-label="t('brightness.admin.level')"
        @input="send($event)" @change="send($event, true)" />
      <p class="ro">{{ status }}</p>
      <BaseButton v-if="here?.available && here.overridden" @click="resume()">{{ t('brightness.admin.resume') }}</BaseButton>
    </BaseField>
    <p v-if="scr.kind === 'device'" class="ro note">{{ t('brightness.admin.deviceLater') }}</p>

    <BaseCheckbox :model-value="b.dayNight.enabled" :label="t('brightness.admin.dayNight')"
      @update:model-value="setDayNight({ enabled: $event })" />
    <template v-if="b.dayNight.enabled">
      <BaseField :label="t('brightness.admin.dayLevel', { percent: b.dayNight.day })">
        <BaseRange :model-value="b.dayNight.day" :step="5" :aria-label="t('brightness.admin.dayLevel', { percent: b.dayNight.day })"
          @change="setDayNight({ day: $event })" />
      </BaseField>
      <BaseField :label="t('brightness.admin.nightLevel', { percent: b.dayNight.night })">
        <BaseRange :model-value="b.dayNight.night" :step="5" :aria-label="t('brightness.admin.nightLevel', { percent: b.dayNight.night })"
          @change="setDayNight({ night: $event })" />
      </BaseField>
      <BaseField :label="t('brightness.admin.schedule')">
        <BaseSegmented :model-value="b.dayNight.schedule" :options="SCHEDULES"
          @update:model-value="setDayNight({ schedule: $event as 'sun' | 'fixed' })" />
      </BaseField>
      <template v-if="b.dayNight.schedule === 'sun'">
        <BaseField :label="t('brightness.admin.city')" :hint="t('brightness.admin.cityHint')">
          <form class="search" @submit.prevent="searchPlaces()">
            <BaseInput v-model="placeQuery" :placeholder="t('brightness.admin.cityPlaceholder')" />
            <BaseButton :disabled="searching || placeQuery.trim().length < 2" @click="searchPlaces()">{{ t('brightness.admin.search') }}</BaseButton>
          </form>
        </BaseField>
        <ul v-if="places" class="places">
          <li v-if="places.length === 0" class="ro">{{ t('brightness.admin.noPlace') }}</li>
          <li v-for="p in places" :key="`${p.latitude},${p.longitude}`">
            <button type="button" class="place" @click="usePlace(p)">
              <strong>{{ p.name }}</strong><span v-if="p.detail"> — {{ p.detail }}</span>
              <span class="coords">{{ p.latitude }}, {{ p.longitude }}</span>
            </button>
          </li>
        </ul>
        <div class="pair">
          <BaseField :label="t('brightness.admin.latitude')">
            <BaseInput lazy :model-value="b.dayNight.latitude ?? ''" placeholder="48.8566"
              @update:model-value="setCoordinate('latitude', $event)" />
          </BaseField>
          <BaseField :label="t('brightness.admin.longitude')">
            <BaseInput lazy :model-value="b.dayNight.longitude ?? ''" placeholder="2.3522"
              @update:model-value="setCoordinate('longitude', $event)" />
          </BaseField>
        </div>
        <p class="ro note">{{ t('brightness.admin.locationHint') }}</p>
        <p v-if="here?.dayNightProblem" class="err">{{ t('brightness.admin.noLocation') }}</p>
      </template>
      <div v-else class="pair">
        <BaseField :label="t('brightness.admin.dayAt')">
          <BaseInput lazy :model-value="b.dayNight.dayAt" placeholder="07:00" @update:model-value="setClock('dayAt', $event)" />
        </BaseField>
        <BaseField :label="t('brightness.admin.nightAt')">
          <BaseInput lazy :model-value="b.dayNight.nightAt" placeholder="21:00" @update:model-value="setClock('nightAt', $event)" />
        </BaseField>
      </div>
      <BaseField :label="t('brightness.admin.ramp')" :hint="t('brightness.admin.rampHint')">
        <BaseInput type="number" lazy :min="0" :max="120" :model-value="b.dayNight.rampMinutes" @update:model-value="setRamp($event)" />
      </BaseField>
    </template>

    <BaseCheckbox :model-value="b.followMac.enabled" :label="t('brightness.admin.followMac')"
      @update:model-value="setFollow({ enabled: $event })" />
    <p v-if="scr.id === kiosk && here && !here.builtin" class="ro note">{{ t('brightness.admin.noBuiltin') }}</p>
    <template v-if="b.followMac.enabled">
      <BaseField :label="t('brightness.admin.scale')" :hint="t('brightness.admin.scaleHint')">
        <BaseRange :model-value="scalePercent" :min="20" :max="300" :step="5" :aria-label="t('brightness.admin.scale')"
          @change="setFollow({ scale: $event / 100 })" />
      </BaseField>
      <BaseField :label="t('brightness.admin.offset')">
        <BaseRange :model-value="b.followMac.offset" :min="-50" :max="50" :step="1" unit="" :aria-label="t('brightness.admin.offset')"
          @change="setFollow({ offset: $event })" />
      </BaseField>
    </template>
    <p v-if="b.dayNight.enabled && b.followMac.enabled" class="ro note">{{ t('brightness.admin.both') }}</p>
    <p v-if="b.dayNight.enabled || b.followMac.enabled" class="ro note">{{ t('brightness.admin.manualRule') }}</p>
  </BaseSection>
</template>

<style scoped>
.search { display: flex; gap: var(--space-2); align-items: center; margin: 0; }
.search > :first-child { flex: 1; min-width: 0; }
.places { list-style: none; margin: 0 0 var(--space-2); padding: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.place { width: 100%; text-align: left; font: inherit; font-size: var(--fs-sm); color: var(--text); background: var(--surface-2, transparent);
  border: 1px solid var(--border, rgba(128,128,128,.3)); border-radius: 8px; padding: var(--space-2) var(--space-3); cursor: pointer; }
.place:hover { border-color: var(--accent); }
.coords { float: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.ro { margin: var(--space-1) 0; color: var(--text-muted); font-size: var(--fs-sm); }
.note { line-height: 1.4; }
.err { margin: var(--space-1) 0; color: var(--danger, #e5534b); font-size: var(--fs-sm); }
</style>
