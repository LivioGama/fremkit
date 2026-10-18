<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { api } from '../shared/api'
import { useI18n } from '../shared/i18n'
import { COMPANION_ALLOW_DELAY_MS, useSettled } from '../shared/useSettled'

/**
 * A browser extension asked to pair: the code it shows and the name it gave, to be matched by eye
 * on this screen before the Mac says yes. Drawn over everything; it hides at `expiresAt` even
 * before the server's next snapshot says the request is gone.
 *
 * Allow waits two seconds whenever the request on show changes, so a request swapped in under the
 * user's finger is not the one approved; the answer also carries the code on show, which the
 * server checks against the waiting request.
 */
const props = defineProps<{ pairing: { requestId: string; code: string; name: string; expiresAt: number } }>()
const { t } = useI18n()
const expired = ref(false)
const failed = ref(false)
const busy = ref(false)
/** The failure the server gave, when it said why (a changed request); otherwise the generic one. */
const reason = ref('')
const settled = useSettled(() => props.pairing.requestId, COMPANION_ALLOW_DELAY_MS)
let timer: number | undefined

watch(() => [props.pairing.requestId, props.pairing.expiresAt], ([id], previous) => {
  window.clearTimeout(timer)
  failed.value = false
  reason.value = ''
  // An answered request stays answered: a new one is the only thing that frees the buttons.
  if (previous === undefined || id !== previous[0]) busy.value = false
  const left = props.pairing.expiresAt - Date.now()
  expired.value = left <= 0
  if (left > 0) timer = window.setTimeout(() => { expired.value = true }, left)
}, { immediate: true })
onUnmounted(() => window.clearTimeout(timer))

/**
 * Sends the answer once. On success the buttons stay disabled until the snapshot takes the prompt
 * away: a second tap would find the request gone (404) and flash "failed" over a pairing that
 * worked. Only a failure frees them again, to try once more.
 */
async function answer(call: (id: string, code: string) => Promise<unknown>) {
  if (busy.value) return
  busy.value = true; failed.value = false; reason.value = ''
  try {
    await call(props.pairing.requestId, props.pairing.code)
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    reason.value = /^HTTP \d+$/.test(message) ? '' : message
    failed.value = true
    busy.value = false
  }
}
</script>

<template>
  <div v-if="!expired" class="companion-prompt" role="alertdialog" aria-live="assertive">
    <div class="card">
      <p class="ask">{{ t('dashboard.companion.request') }}</p>
      <p class="name">{{ pairing.name }}</p>
      <p class="code">{{ pairing.code }}</p>
      <p v-if="failed" class="error" role="alert">{{ reason || t('dashboard.companion.failed') }}</p>
      <div class="actions">
        <button type="button" class="refuse" :disabled="busy" @click="answer(api.refuseCompanion)">{{ t('dashboard.companion.refuse') }}</button>
        <button type="button" class="approve" :disabled="busy || !settled" @click="answer(api.approveCompanion)">{{ t('dashboard.companion.approve') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.companion-prompt {
  position: absolute; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--bg) 80%, transparent); font-family: var(--font); color: var(--text);
}
.card {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-5);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 16px; text-align: center;
}
.card p { margin: 0; }
.ask { font-size: var(--fs-lg); }
.name { color: var(--accent); font-size: var(--fs-lg); font-weight: 600; }
.code { font-family: var(--font-mono); font-size: 96px; line-height: 1; letter-spacing: 0.15em; font-weight: 700; }
.error { color: var(--danger); font-size: var(--fs-sm); }
.actions { display: flex; gap: var(--space-3); }
button {
  min-width: 160px; min-height: 56px; padding: 0 var(--space-5); border-radius: 12px; font: inherit;
  font-size: var(--fs-lg); font-weight: 600; cursor: pointer; border: 1px solid var(--border-strong);
  background: var(--surface-3); color: var(--text);
}
button.approve { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
button:disabled { opacity: 0.6; }
</style>
