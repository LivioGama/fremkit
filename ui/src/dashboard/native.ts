import { watch, type Ref } from 'vue'
import type { DeviceInfo } from './remote'

/** What the page tells the iPad app that hosts it. */
export type NativeMessage =
  | { type: 'unauthorized' }
  | { type: 'screen'; screenId: string | null }
  | { type: 'brightness'; target: number; seq: number }

interface NativeWindow {
  webkit?: { messageHandlers?: { fremkit?: { postMessage(msg: unknown): void } } }
}

/** The app's message handler, or null when the page runs in a plain browser. */
export function nativeBridge(win: Window = window): { post(msg: NativeMessage): void } | null {
  const handler = (win as unknown as NativeWindow).webkit?.messageHandlers?.fremkit
  if (!handler) return null
  return {
    post(msg) {
      try { handler.postMessage(msg) } catch { /* the app is gone: nothing to tell */ }
    },
  }
}

/**
 * Reports to the app that the device was revoked (once), which screen it shows, and the brightness
 * target of that screen (once per `seq`). Outside the app it does nothing.
 */
export function useNativeBridge(
  device: Ref<DeviceInfo | null>,
  unauthorized: Ref<boolean>,
  win: Window = window,
): void {
  const bridge = nativeBridge(win)
  if (!bridge) return

  let sentUnauthorized = false
  watch(unauthorized, (v) => {
    if (!v || sentUnauthorized) return
    sentUnauthorized = true
    bridge.post({ type: 'unauthorized' })
  }, { immediate: true })

  let screenSent = false
  let lastScreen: string | null = null
  watch(() => device.value?.screenId, () => {
    if (!device.value) return
    const id = device.value.screenId
    if (screenSent && id === lastScreen) return
    screenSent = true
    lastScreen = id
    bridge.post({ type: 'screen', screenId: id })
  }, { immediate: true })

  let lastSeq = -Infinity
  watch(() => device.value?.brightness, (b) => {
    if (!b || b.target === null || b.seq <= lastSeq) return
    lastSeq = b.seq
    bridge.post({ type: 'brightness', target: b.target, seq: b.seq })
  }, { immediate: true })
}
