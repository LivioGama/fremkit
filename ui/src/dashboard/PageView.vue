<script setup lang="ts">
import { computed } from 'vue'
import type { Config, Page, Display, WidgetManifest } from '../shared/types'
import { backgroundStyle } from '../shared/background'
import { tileOf } from '../shared/screens'
import WidgetFrame from './WidgetFrame.vue'

/** `config` is where a placement's widget, settings and look are read: the page stores only where it sits. */
const props = defineProps<{ page: Page; config: Pick<Config, 'widgets'>; display: Display; manifests: Record<string, WidgetManifest>; edit?: boolean }>()

/** Each placement joined with the shared widget it names: the tile shape every frame and the bridge speak. */
const tiles = computed(() => props.page.items.map((p) => tileOf(props.config, p)))

// The configured background lives here rather than on the dashboard stage, because this is the
// one component the real dashboard and the admin's canvas preview share: putting it anywhere
// else would mean the preview and the screen could drift apart.
const style = computed(() => ({
  height: props.display.rows * props.display.cell + 'px',
  ...backgroundStyle(props.display.background),
}))
</script>

<template>
  <!--
    The key is the instance id alone: settings go to the running widget over the bridge
    (fremkit:settings) and the appearance over fremkit:appearance, so neither typing in the
    inspector nor recolouring a tile reloads the iframe.
  -->
  <div class="page" :style="style">
    <WidgetFrame
      v-for="w in tiles"
      :key="w.instanceId"
      :instance="w"
      :manifest="manifests[w.widgetId]"
      :cell="display.cell"
      :edit="edit"
    />
  </div>
</template>

<style scoped>
.page { position: relative; width: 100%; overflow: hidden; }
</style>
