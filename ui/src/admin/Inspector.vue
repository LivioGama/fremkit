<script setup lang="ts">
import WidgetInspector from './WidgetInspector.vue'
import PageInspector from './PageInspector.vue'
import { useAdminStore } from './store'

const s = useAdminStore()
</script>

<template>
  <aside class="inspector">
    <div class="body">
      <WidgetInspector />
      <!-- With no widget selected, the inspector edits the page being shown. -->
      <PageInspector v-if="!s.selected.value" />
    </div>
  </aside>
</template>

<style scoped>
.inspector { width: 300px; flex: 0 0 auto; display: flex; flex-direction: column;
  background: var(--surface); border-left: 1px solid var(--border); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-3); }
</style>
