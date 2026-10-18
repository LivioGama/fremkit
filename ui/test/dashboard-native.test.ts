/**
 * @vitest-environment jsdom
 *
 * The page tells the iPad app about revocation, its screen and its brightness target, through
 * `webkit.messageHandlers.fremkit`. Outside the app there is no handler and nothing happens.
 */
import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { nativeBridge, useNativeBridge } from '../src/dashboard/native'
import type { DeviceInfo } from '../src/dashboard/remote'

function appWindow() {
  const postMessage = vi.fn()
  const win = { webkit: { messageHandlers: { fremkit: { postMessage } } } } as unknown as Window
  return { win, postMessage }
}

function info(over: Partial<DeviceInfo> = {}): DeviceInfo {
  return { id: 'd1', name: 'Kitchen iPad', screenId: 'pad', brightness: null, ...over }
}

describe('nativeBridge', () => {
  it('is null outside the app', () => {
    expect(nativeBridge({} as Window)).toBeNull()
    expect(nativeBridge({ webkit: {} } as unknown as Window)).toBeNull()
  })

  it('posts to the fremkit handler inside the app', () => {
    const { win, postMessage } = appWindow()
    nativeBridge(win)!.post({ type: 'unauthorized' })
    expect(postMessage).toHaveBeenCalledWith({ type: 'unauthorized' })
  })
})

describe('useNativeBridge', () => {
  it('does nothing and never throws without a handler', async () => {
    const device = ref<DeviceInfo | null>(null)
    const unauthorized = ref(false)
    expect(() => useNativeBridge(device, unauthorized, {} as Window)).not.toThrow()
    device.value = info({ brightness: { target: 40, seq: 1 } })
    unauthorized.value = true
    await nextTick()
  })

  it('posts unauthorized once, even if the flag is set twice', async () => {
    const { win, postMessage } = appWindow()
    const unauthorized = ref(false)
    useNativeBridge(ref(null), unauthorized, win)
    unauthorized.value = true
    await nextTick()
    unauthorized.value = false
    unauthorized.value = true
    await nextTick()
    expect(postMessage.mock.calls.filter(([m]) => m.type === 'unauthorized')).toHaveLength(1)
  })

  it('posts the screen whenever it changes', async () => {
    const { win, postMessage } = appWindow()
    const device = ref<DeviceInfo | null>(null)
    useNativeBridge(device, ref(false), win)
    expect(postMessage).not.toHaveBeenCalled()
    device.value = info({ screenId: 'pad' })
    await nextTick()
    device.value = info({ screenId: 'pad' })
    await nextTick()
    device.value = info({ screenId: null })
    await nextTick()
    expect(postMessage.mock.calls.map(([m]) => m)).toEqual([
      { type: 'screen', screenId: 'pad' },
      { type: 'screen', screenId: null },
    ])
  })

  it('posts a brightness target once per seq, and never a null target', async () => {
    const { win, postMessage } = appWindow()
    const device = ref<DeviceInfo | null>(info({ brightness: { target: 40, seq: 3 } }))
    useNativeBridge(device, ref(false), win)
    const brightness = () => postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === 'brightness')
    await nextTick()
    expect(brightness()).toEqual([{ type: 'brightness', target: 40, seq: 3 }])

    device.value = info({ brightness: { target: 40, seq: 3 } })
    await nextTick()
    expect(brightness()).toHaveLength(1)

    device.value = info({ brightness: { target: 55, seq: 4 } })
    await nextTick()
    expect(brightness()).toHaveLength(2)
    expect(brightness()[1]).toEqual({ type: 'brightness', target: 55, seq: 4 })

    device.value = info({ brightness: { target: null, seq: 5 } })
    await nextTick()
    expect(brightness()).toHaveLength(2)
  })
})
