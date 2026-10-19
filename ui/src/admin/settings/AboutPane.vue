<script setup lang="ts">
/**
 * The version, the people, the links and the diagnostics. Moved out of the former
 * ScreenInspector.vue.
 */
import { computed } from 'vue'
import BaseSection from '../../shared/ui/BaseSection.vue'
import DiagnosticsSection from '../DiagnosticsSection.vue'
import { useI18n } from '../../shared/i18n'
import { CONTRIBUTORS, MAINTAINER, REGISTRY_REPOSITORY, REPOSITORY, VERSION } from '../../shared/credits'

const { t, locale } = useI18n()

/** "A, B and C" in the language in force, so a third contributor needs no new string. */
const contributors = computed(() =>
  new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(CONTRIBUTORS.map((p) => p.handle)))
</script>

<template>
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
  <DiagnosticsSection />
  </BaseSection>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.links { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: 0 0 var(--space-2);
  font-size: var(--fs-sm); color: var(--text-muted); }
.links dd { margin: 0; min-width: 0; }
.links a { color: var(--accent); text-decoration: none; }
.links a:hover { text-decoration: underline; }
</style>
