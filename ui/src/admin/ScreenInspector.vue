<script setup lang="ts">
import { computed } from 'vue'
import { ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { api } from '../shared/api'
import type { RestoreResult } from '../shared/api'
import BaseColor from '../shared/ui/BaseColor.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseRange from '../shared/ui/BaseRange.vue'
import BaseSection from '../shared/ui/BaseSection.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import BackgroundPicker from './BackgroundPicker.vue'
import NavWidgetsEditor from './NavWidgetsEditor.vue'
import DevicesSection from './DevicesSection.vue'
import { useDevices } from './devices'
import ScreenBrightness from './ScreenBrightness.vue'
import { surfaceOpacity } from '../shared/background'
import { pick, useI18n, type Locale } from '../shared/i18n'
import { useConfirm } from '../shared/useConfirm'
import { CONTRIBUTORS, MAINTAINER, REGISTRY_REPOSITORY, REPOSITORY, VERSION } from '../shared/credits'
import { BUILTIN_THEME, useThemes } from '../shared/theme'
import { ADMIN_GESTURES, DEFAULT_ADMIN_GESTURE, DEFAULT_NAV_STYLE, NAV_HEIGHTS, navHasRoom, navHeightOf,
  type AdminGesture, type Background, type Config, type NavHeight, type NavStyle, type Screen } from '../shared/types'
import { pickScreen, screensShowing } from '../shared/screens'
import { useAdminStore } from './store'

const s = useAdminStore()
const { t, locale } = useI18n()
const LANGUAGES = computed(() => (['fr', 'en'] as const).map((value) => ({
  value, label: t(`admin.inspector.screen.language.${value}`),
})))

/**
 * The language goes through `apply` like every other setting, so it is undoable and saved with
 * the rest of the config. The store watches `config.locale`, which is what repaints the admin.
 */
function setLocale(value: string): void {
  const next = (value === 'en' ? 'en' : 'fr') as Locale
  if (next !== s.state.config!.locale) s.apply((c) => { c.locale = next })
}
const { themes, errors: themeErrors, rescan: rescanThemes } = useThemes()
/** The built-in theme first, then the others by name: the list reads as "the default, and yours". */
const themeOptions = computed(() => {
  const list = Object.values(themes.value)
    .sort((a, b) => (a.id === BUILTIN_THEME ? -1 : b.id === BUILTIN_THEME ? 1 : pick(a.name).localeCompare(pick(b.name))))
    .map((theme) => ({ id: theme.id, label: pick(theme.name), description: pick(theme.description ?? '') }))
  // A config naming a theme whose folder is gone still shows it, rather than an empty select.
  const current = s.state.config!.theme ?? BUILTIN_THEME
  if (!list.some((o) => o.id === current)) list.push({ id: current, label: current, description: t('admin.inspector.screen.theme.missing') })
  return list
})
const currentTheme = computed(() => s.state.config!.theme ?? BUILTIN_THEME)
const themeNote = computed(() => themeOptions.value.find((o) => o.id === currentTheme.value)?.description ?? '')
function setTheme(id: string): void {
  if (id !== currentTheme.value) s.apply((c) => { c.theme = id })
}

/** "A, B and C" in the language in force, so a third contributor needs no new string. */
const contributors = computed(() =>
  new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(CONTRIBUTORS.map((p) => p.handle)))

const privacy = computed(() => s.state.config!.privacy)
/**
 * Turning the Claude usage on is the whole consent step: until it is ticked the server does not
 * read the keychain item and sends nothing. The hint below spells out what is read and where it
 * goes, so the box is never the only thing the user has to go on.
 */
function setClaudeAccountUsage(on: boolean): void {
  s.apply((c) => { c.privacy.claudeAccountUsage = on })
}
const CODEX_SOURCES = ['appServer', 'vscode', 'cli', 'exec', 'subAgent', 'unknown'] as const
const CODEX_SUBAGENT_SOURCES = ['subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'] as const
type CodexSource = typeof CODEX_SOURCES[number] | typeof CODEX_SUBAGENT_SOURCES[number]
function setCodexAccount(on: boolean): void {
  s.apply((c) => { c.privacy.codexAccount = on })
}
function setCodexSource(source: CodexSource, on: boolean): void {
  s.apply((c) => { c.privacy.codexHistorySources = on
    ? [...new Set([...c.privacy.codexHistorySources, source])]
    : c.privacy.codexHistorySources.filter(value => value !== source) })
}
function setMacmonTemperature(on: boolean): void {
  s.apply((c) => { c.privacy.macmonTemperature = on })
}
/**
 * Off, the server leaves the account e-mail out of every snapshot it publishes; this box does
 * not hide it in a widget, it decides whether any widget is sent it at all.
 */
function setShowAccountEmail(on: boolean): void {
  s.apply((c) => { c.privacy.showAccountEmail = on })
}
/**
 * Backup and restore.
 *
 * The archive holds the config and the background library and never a secret: those live in the
 * macOS keychain. A restore therefore replaces the dashboard and leaves every connection needing
 * its secret typed in again — which is what the confirmation says and what the result lists.
 */
const restoreInput = ref<HTMLInputElement>()
const restoring = ref(false)
const restored = ref<RestoreResult | null>(null)
const restoreError = ref('')

const confirm = useConfirm()
function confirmRestore(): void {
  confirm.ask('restore', () => restoreInput.value?.click())
}

async function onRestoreFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Cleared either way, so picking the same file twice still fires a change event.
  input.value = ''
  if (!file) return
  restoring.value = true
  restored.value = null
  restoreError.value = ''
  try {
    restored.value = await api.restoreBackup(file)
    // The whole dashboard changed underneath the admin: reload it rather than reconcile it.
    await s.load()
  } catch (err) {
    restoreError.value = (err as Error).message
  } finally {
    restoring.value = false
  }
}

const scr = computed(() => s.screen.value!)
/** An emptied name is not a name: the field snaps back to the current one instead. */
function rename(value: string | number): void {
  s.renameScreen(scr.value.id, String(value))
}
/** The widgets that would go with this screen: those no other screen shows. */
const onlyHere = computed(() => {
  const cfg = s.state.config!
  const ids = new Set([...scr.value.nav.map((x) => x.instanceId), ...scr.value.pages.flatMap((p) => p.items.map((x) => x.instanceId))])
  return [...ids].filter((id) => screensShowing(cfg, id).every((x) => x.id === scr.value.id)).length
})
const lastScreen = computed(() => s.state.config!.screens.length <= 1)
const removeKey = computed(() => `screen:${scr.value.id}`)
/** The paired devices this screen is on: removing it leaves them with nothing to show. */
const devices = useDevices()
const showingHere = computed(() => devices.showing(scr.value.id).map((d) => d.name).join(', '))
function confirmRemoveScreen(): void {
  const id = scr.value.id
  // Arming re-reads the list, so the warning names the devices as they are now.
  if (!confirm.armed(removeKey.value) && scr.value.kind === 'device') void devices.refresh()
  confirm.ask(removeKey.value, () => s.removeScreen(id))
}

/** The selected screen's display: every setting below is that screen's, not the others'. */
const d = computed(() => s.screen.value!.display)
/** The selected screen inside the config a mutation is handed. */
const onScreen = (c: Config): Screen => c.screens.find((x) => x.id === s.screen.value!.id)!
const bg = computed<Background>(() => d.value.background ?? {})
const navHeight = computed(() => navHeightOf(d.value))
/** "80 px" and "40 px" read the same in both languages, so the labels need no dictionary entry. */
const NAV_OPTIONS = NAV_HEIGHTS.map((h) => ({ value: String(h), label: `${h} px` }))
/**
 * The selected screen's own dashboard address. `/?kiosk=1` alone shows the first Edge screen,
 * which is what the helper opens; naming the screen is what opens any other one.
 */
const kioskUrl = computed(() => `${location.origin}/?screen=${encodeURIComponent(scr.value.id)}&kiosk=1`)
/** An Edge screen other than the one the helper shows is drawn nowhere yet. */
const unshownEdge = computed(() => scr.value.kind === 'edge' && pickScreen(s.state.config!, null).id !== scr.value.id)
const NAV_STYLE_OPTIONS = computed(() => (['dots', 'names'] as const).map((value) => ({
  value, label: t(`admin.inspector.screen.navStyle.${value}`),
})))
/**
 * Dots or names in this screen's bar. Names take more of the centre, so the switch is refused
 * when this screen's clusters would not leave them their room.
 */
function setNavStyle(value: string): void {
  const next = value as NavStyle
  const candidate: Screen = { ...scr.value, display: { ...d.value, navStyle: next } }
  if (!navHasRoom(candidate, s.state.config!.widgets, s.state.manifests, 0)) {
    s.state.toast = t('admin.inspector.screen.navStyle.noRoom')
    return
  }
  s.apply((c) => { onScreen(c).display.navStyle = next === DEFAULT_NAV_STYLE ? undefined : next })
}

/** The slider works in whole percents; the config stores the 0–1 opacity itself. */
const ADMIN_GESTURE_OPTIONS = computed(() => ADMIN_GESTURES.map((value) => ({
  value, label: t(`admin.inspector.screen.adminGesture.${value}`),
})))
/**
 * How the admin is reached from the screen. `both` is the default and is stored as an absent key,
 * like every other default here.
 */
function setAdminGesture(value: string): void {
  const next = value as AdminGesture
  s.apply((c) => { onScreen(c).display.adminGesture = next === DEFAULT_ADMIN_GESTURE ? undefined : next })
}

const navOpacityPercent = computed(() => Math.round(surfaceOpacity(d.value.navOpacity) * 100))
/** A solid bar is the default, so it is stored as an absent key rather than an explicit 1. */
function setNavOpacity(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent))
  s.apply((c) => { onScreen(c).display.navOpacity = clamped === 100 ? undefined : clamped / 100 })
}

const tileOpacityPercent = computed(() => Math.round(surfaceOpacity(d.value.tileOpacity) * 100))
/** Solid is the default, so it is stored as an absent key rather than an explicit 1. */
function setTileOpacity(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent))
  s.apply((c) => { onScreen(c).display.tileOpacity = clamped === 100 ? undefined : clamped / 100 })
}

/** An emptied field is NaN, which the schema would reject: ignore it instead of writing it. */
function setAutoCycle(value: string | number): void {
  const n = Number(value)
  if (Number.isFinite(n)) s.apply((c) => { onScreen(c).display.autoCycleSeconds = Math.max(0, Math.round(n)) })
}

/**
 * One mutation path for the whole background object: keys set to `undefined` are dropped, and
 * an object left with nothing in it goes away entirely, so clearing everything restores the
 * default exactly as it was — which is what makes undo round-trip cleanly.
 */
function setBackground(patch: Partial<Background>): void {
  s.apply((c) => {
    const next = { ...bg.value, ...patch } as Record<string, unknown>
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k]
    onScreen(c).display.background = Object.keys(next).length ? (next as Background) : undefined
  })
}

</script>

<template>
  <BaseField :label="t('admin.inspector.screen.name')">
    <!-- Keyed by screen: switching screens must not carry the other one's half-typed name over. -->
    <BaseInput :key="scr.id" lazy :model-value="scr.name" :aria-label="t('admin.inspector.screen.name')"
      @update:model-value="rename($event)" />
  </BaseField>
  <div class="row">
    <!-- Two taps, the first saying what goes with it; the last screen cannot go at all. -->
    <BaseButton v-if="confirm.armed(removeKey)" variant="danger" @click="confirmRemoveScreen()">
      {{ t('admin.inspector.screen.remove.confirmButton') }}
    </BaseButton>
    <BaseButton v-else variant="danger" :disabled="lastScreen" @click="confirmRemoveScreen()">
      <BaseIcon name="trash-2" :size="16" />{{ t('admin.inspector.screen.remove') }}
    </BaseButton>
  </div>
  <p v-if="confirm.armed(removeKey)" class="ro warn">{{ t('admin.inspector.screen.remove.confirm', { name: scr.name, count: onlyHere }) }}</p>
  <p v-if="confirm.armed(removeKey) && showingHere" class="ro warn" data-test="remove-devices">{{ t('admin.inspector.screen.remove.devices', { names: showingHere }) }}</p>
  <p v-else-if="lastScreen" class="ro">{{ t('admin.inspector.screen.remove.last') }}</p>

  <BaseField :label="t('admin.inspector.screen.language')">
    <BaseSegmented :model-value="locale" :options="LANGUAGES" @update:model-value="setLocale($event)" />
  </BaseField>

  <BaseField :label="t('admin.inspector.screen.theme')" :hint="t('admin.inspector.screen.theme.hint')">
    <div class="theme">
      <select :value="currentTheme" :aria-label="t('admin.inspector.screen.theme')"
        @change="setTheme(($event.target as HTMLSelectElement).value)">
        <option v-for="o in themeOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
      </select>
      <BaseButton variant="icon" :title="t('admin.inspector.screen.theme.rescan')" @click="rescanThemes()">
        <BaseIcon name="refresh-cw" :size="16" />
      </BaseButton>
    </div>
  </BaseField>
  <p v-if="themeNote" class="ro note">{{ themeNote }}</p>
  <p v-for="e in themeErrors" :key="e.id" class="err">{{ e.id }} — {{ e.error }}</p>

  <BaseSection id="screen.layout" :title="t('admin.inspector.screen.layout')">
  <BaseField :label="t('admin.inspector.screen.grid')"
    :hint="t(scr.kind === 'device' ? 'admin.inspector.screen.grid.hint.device' : 'admin.inspector.screen.grid.hint')">
    <p class="ro">{{ t('admin.inspector.screen.grid.value', { cols: d.cols, rows: d.rows, cell: d.cell }) }}</p>
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.area')">
    <p class="ro">{{ t('admin.inspector.screen.area.value', { width: d.cols * d.cell, height: d.rows * d.cell, nav: navHeight }) }}</p>
  </BaseField>
  <!-- A device screen was made for one orientation and one viewport; changing either is adding
       a screen, so both are shown, not edited. -->
  <template v-if="scr.kind === 'device'">
    <BaseField v-if="d.orientation" :label="t('admin.inspector.screen.orientation')">
      <p class="ro">{{ t(`admin.inspector.screen.orientation.${d.orientation}`) }}</p>
    </BaseField>
    <BaseField v-if="d.viewport" :label="t('admin.inspector.screen.viewport')">
      <p class="ro">{{ t('admin.inspector.screen.viewport.value', { width: d.viewport.width, height: d.viewport.height }) }}</p>
    </BaseField>
  </template>
  <BaseField :label="t('admin.inspector.screen.navHeight')" :hint="t('admin.inspector.screen.navHeight.hint')">
    <BaseSegmented :model-value="String(navHeight)" :options="NAV_OPTIONS"
      @update:model-value="s.setNavHeight(Number($event) as NavHeight)" />
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.navStyle')" :hint="t('admin.inspector.screen.navStyle.hint')">
    <BaseSegmented :model-value="d.navStyle ?? DEFAULT_NAV_STYLE" :options="NAV_STYLE_OPTIONS"
      @update:model-value="setNavStyle($event)" />
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.adminGesture')"
    :hint="t('admin.inspector.screen.adminGesture.hint')">
    <BaseSegmented :model-value="d.adminGesture ?? DEFAULT_ADMIN_GESTURE" :options="ADMIN_GESTURE_OPTIONS"
      @update:model-value="setAdminGesture($event)" />
  </BaseField>

  <BaseField :label="t('admin.inspector.screen.navOpacity', { percent: navOpacityPercent })"
    :hint="t('admin.inspector.screen.navOpacity.hint')">
    <BaseRange :model-value="navOpacityPercent" :step="5"
      :aria-label="t('admin.inspector.screen.navOpacity.aria')" @change="setNavOpacity" />
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.tileOpacity', { percent: tileOpacityPercent })"
    :hint="t('admin.inspector.screen.tileOpacity.hint')">
    <BaseRange :model-value="tileOpacityPercent" :step="5"
      :aria-label="t('admin.inspector.screen.tileOpacity.aria')" @change="setTileOpacity" />
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.autoCycle')">
    <BaseInput type="number" lazy :min="0" :model-value="d.autoCycleSeconds"
      @update:model-value="setAutoCycle($event)" />
  </BaseField>

  </BaseSection>

  <BaseSection id="screen.navWidgets" :title="t('admin.inspector.screen.navWidgets')">
    <NavWidgetsEditor />
  </BaseSection>

  <BaseSection id="screen.background" :title="t('admin.inspector.screen.background')">
  <BaseField :label="t('admin.inspector.screen.color')" :hint="t('admin.inspector.screen.color.hint')">
    <BaseColor :model-value="bg.color ?? ''" fallback="#0b0d10" :reset-label="t('common.reset')"
      :aria-label="t('admin.inspector.screen.color.aria')"
      @update:model-value="setBackground({ color: $event })" @reset="setBackground({ color: undefined })" />
  </BaseField>

  <BackgroundPicker :model-value="bg" @update="setBackground($event)" />
  </BaseSection>

  <ScreenBrightness />

  <BaseSection id="screen.kiosk" :title="t('admin.inspector.screen.kiosk')">
  <BaseField :label="t('admin.inspector.screen.kioskUrl')">
    <p class="ro mono">{{ kioskUrl }}</p>
  </BaseField>
  <p v-if="unshownEdge" class="ro">{{ t('admin.screens.edgeNote') }}</p>

  </BaseSection>

  <BaseSection id="screen.devices" :title="t('admin.inspector.screen.devices')">
    <DevicesSection />
  </BaseSection>

  <BaseSection id="screen.backup" :title="t('admin.inspector.screen.backup')">
  <div class="row">
    <BaseButton @click="api.downloadBackup()">
      <BaseIcon name="download" :size="16" />{{ t('admin.inspector.screen.backup.download') }}
    </BaseButton>
    <!-- Two taps: the first says what a restore does, the second opens the file picker. -->
    <BaseButton v-if="confirm.armed('restore')" variant="danger" :disabled="restoring" @click="confirmRestore()">
      {{ t('admin.inspector.screen.restore.confirmButton') }}
    </BaseButton>
    <BaseButton v-else :disabled="restoring" @click="confirmRestore()">
      <BaseIcon name="upload" :size="16" />{{ t('admin.inspector.screen.backup.restore') }}
    </BaseButton>
  </div>
  <input ref="restoreInput" type="file" accept=".zip,application/zip" class="hidden" @change="onRestoreFile" />
  <p v-if="confirm.armed('restore')" class="ro warn">{{ t('admin.inspector.screen.restore.confirm') }}</p>
  <p v-else class="ro">{{ t('admin.inspector.screen.backup.hint') }}</p>
  <p v-if="restoreError" class="bad">{{ restoreError }}</p>
  <template v-if="restored">
    <p class="ok">{{ t('admin.inspector.screen.restore.done', { screens: restored.screens, pages: restored.pages, backgrounds: restored.backgrounds }) }}</p>
    <p v-if="restored.reenterSecrets.length" class="ro">
      {{ t('admin.inspector.screen.restore.reenter') }}
      <strong>{{ restored.reenterSecrets.map((c) => c.name).join(', ') }}</strong>
    </p>
    <!-- The common case, and worth saying: restoring onto the same Mac finds the keychain items,
         because they are keyed by the connection ids the archive carries. -->
    <p v-else class="ro">{{ t('admin.inspector.screen.restore.nothingToReenter') }}</p>
  </template>

  </BaseSection>

  <BaseSection id="screen.privacy" :title="t('admin.inspector.screen.privacy')">
  <BaseCheckbox :model-value="privacy.claudeAccountUsage"
    :label="t('admin.inspector.screen.claudeUsage')"
    @update:model-value="setClaudeAccountUsage($event)" />
  <p class="ro">{{ t('admin.inspector.screen.claudeUsage.hint') }}</p>
  <BaseCheckbox :model-value="privacy.showAccountEmail"
    :label="t('admin.inspector.screen.accountEmail')"
    @update:model-value="setShowAccountEmail($event)" />
  <p class="ro">{{ t('admin.inspector.screen.accountEmail.hint') }}</p>
  <BaseCheckbox :model-value="privacy.codexAccount"
    :label="t('admin.inspector.screen.codexAccount')"
    @update:model-value="setCodexAccount($event)" />
  <p class="ro">{{ t('admin.inspector.screen.codexAccount.hint') }}</p>
  <p class="ro">{{ t('admin.inspector.screen.codexSources') }}</p>
  <p class="ro">{{ t('admin.inspector.screen.codexSources.hint') }}</p>
  <div class="codex-sources">
    <BaseCheckbox v-for="source in CODEX_SOURCES" :key="source"
      :model-value="privacy.codexHistorySources.includes(source)"
      :label="t('admin.inspector.screen.codexSource.' + source)"
      @update:model-value="setCodexSource(source, $event)" />
  </div>
  <details class="codex-subagent-sources">
    <summary>{{ t('admin.inspector.screen.codexSources.subagents') }}</summary>
    <div class="codex-sources">
      <BaseCheckbox v-for="source in CODEX_SUBAGENT_SOURCES" :key="source"
        :model-value="privacy.codexHistorySources.includes(source)"
        :label="t('admin.inspector.screen.codexSource.' + source)"
        @update:model-value="setCodexSource(source, $event)" />
    </div>
  </details>
  <BaseCheckbox :model-value="privacy.macmonTemperature"
    :label="t('admin.inspector.screen.macmonTemperature')"
    @update:model-value="setMacmonTemperature($event)" />
  <p class="ro">{{ t('admin.inspector.screen.macmonTemperature.hint') }}</p>
  </BaseSection>

  <BaseSection id="screen.about" :title="t('admin.inspector.screen.about')">
  <p class="ro">{{ t('admin.inspector.screen.about.version', { version: VERSION }) }}</p>
  <p class="ro">{{ t('admin.inspector.screen.about.authors', { maintainer: MAINTAINER.handle, contributors }) }}</p>
  <!-- A new tab in a browser; the helper's admin window hands these to the default browser
       rather than replacing the admin with them. -->
  <dl class="links">
    <dt>{{ t('admin.inspector.screen.about.source') }}</dt>
    <dd><a class="mono" :href="REPOSITORY" target="_blank" rel="noopener noreferrer">{{ REPOSITORY.replace('https://', '') }}</a></dd>
    <dt>{{ t('admin.inspector.screen.about.sietch') }}</dt>
    <dd><a class="mono" :href="REGISTRY_REPOSITORY" target="_blank" rel="noopener noreferrer">{{ REGISTRY_REPOSITORY.replace('https://', '') }}</a></dd>
  </dl>
  <p class="ro">{{ t('admin.inspector.screen.about.registry') }}</p>
  <p class="ro">{{ t('admin.inspector.screen.about.icons') }}</p>
  </BaseSection>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.ro.warn { color: var(--danger); }
.codex-sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: var(--space-1); margin-bottom: var(--space-3); }
.codex-subagent-sources { margin-bottom: var(--space-3); }
.codex-subagent-sources summary { cursor: pointer; margin-bottom: var(--space-2); }
.row { display: flex; gap: var(--space-2); margin-bottom: var(--space-2); }
.hidden { display: none; }
.bad { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--danger); white-space: pre-wrap; }
.ok { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--ok); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.links { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: 0 0 var(--space-2);
  font-size: var(--fs-sm); color: var(--text-muted); }
.links dd { margin: 0; min-width: 0; }
.links a { color: var(--accent); text-decoration: none; }
.links a:hover { text-decoration: underline; }
h3 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: var(--space-4) 0 var(--space-2); }
.theme { display: flex; gap: var(--space-2); align-items: center; }
.theme select { flex: 1; min-width: 0; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.note { margin: calc(var(--space-2) * -1) 0 var(--space-3); }
.err { color: var(--danger); font-size: var(--fs-xs); margin: 0 0 var(--space-2); }
</style>
