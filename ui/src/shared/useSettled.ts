import { onUnmounted, ref, watch, type Ref } from 'vue'

/** How long Allow stays off after the pairing request on show changes. */
export const COMPANION_ALLOW_DELAY_MS = 2000

/**
 * False for `ms` after `key` takes a new value (and after the first one), true otherwise.
 *
 * For a button that must not take a tap meant for what was on screen a moment ago: a pairing
 * request swapped in just before the user's finger lands is not the one they read the code of.
 * A key that goes to null or undefined settles at once: there is nothing to answer.
 */
export function useSettled(key: () => unknown, ms: number): Ref<boolean> {
  const settled = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(key, (value) => {
    clearTimeout(timer)
    timer = undefined
    if (value === null || value === undefined) { settled.value = true; return }
    settled.value = false
    timer = setTimeout(() => { settled.value = true; timer = undefined }, ms)
  }, { immediate: true })
  onUnmounted(() => clearTimeout(timer))
  return settled
}
