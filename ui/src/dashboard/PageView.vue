<script setup lang="ts">
import { computed } from 'vue'
import type { Config, Page, Display, WidgetManifest } from '../shared/types'
import { backgroundStyle } from '../shared/background'
import { tileOf } from '../shared/screens'
import WidgetFrame from './WidgetFrame.vue'

/** `config` is where a placement's widget, settings and look are read: the page stores only where it sits. */
const props = withDefaults(defineProps<{
  page: Page; config: Pick<Config, 'widgets'>; display: Display; manifests: Record<string, WidgetManifest>; edit?: boolean
  /**
   * Whether the page paints the screen's background itself. The admin's previews do; the
   * dashboard turns it off and paints it once behind the whole screen, bar included, so a
   * viewport larger than the grid shows no second, differently scaled copy.
   */
  paintBackground?: boolean
}>(), { paintBackground: true })

/** Each placement joined with the shared widget it names: the tile shape every frame and the bridge speak. */
const tiles = computed(() => props.page.items.map((p) => tileOf(props.config, p)))

// The admin's previews paint the configured background here. The dashboard paints it on its
// root instead, sized against the same grid area, so on the Edge the two still match exactly.
const style = computed(() => ({
  height: props.display.rows * props.display.cell + 'px',
  ...(props.paintBackground ? backgroundStyle(props.display.background) : {}),
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
