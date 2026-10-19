<script setup lang="ts">
import WidgetInspector from './WidgetInspector.vue'
import PageInspector from './PageInspector.vue'
import SelectionInspector from './SelectionInspector.vue'
import { useAdminStore } from './store'

const s = useAdminStore()
</script>

<template>
  <aside class="inspector">
    <div class="body">
      <!-- Several selected: what they share. One: that widget. None: the page being shown. -->
      <SelectionInspector v-if="s.state.selection.length > 1" />
      <template v-else>
        <WidgetInspector />
        <PageInspector v-if="!s.selected.value" />
      </template>
    </div>
  </aside>
</template>

<style scoped>
.inspector { width: 300px; flex: 0 0 auto; display: flex; flex-direction: column;
  background: var(--surface); border-left: 1px solid var(--border); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-3); }
</style>
