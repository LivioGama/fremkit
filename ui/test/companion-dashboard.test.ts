/**
 * @vitest-environment jsdom
 *
 * The browser extension on the Edge: the pairing prompt, and the page a share lands on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { Config } from '../src/shared/types'
import { createRevealTracker } from '../src/dashboard/companionReveal'

const fake = vi.hoisted(() => ({
  subs: new Map<string, Set<(data: unknown) => void>>(),
  config: null as unknown,
  approve: vi.fn(async (_id: string) => {}),
  refuse: vi.fn(async (_id: string) => {}),
}))

vi.mock('../src/shared/socket', async () => {
  const { ref } = await import('vue')
  const socket = {
    status: ref('open'),
    subscribe(channel: string, cb: (data: unknown) => void) {
      let set = fake.subs.get(channel)
      if (!set) { set = new Set(); fake.subs.set(channel, set) }
      set.add(cb)
      return () => { set!.delete(cb) }
    },
    command: async () => undefined,
  }
  return { useSocket: () => socket }
})
vi.mock('../src/shared/api', () => ({
  api: {
    getWidgets: async () => ({ widgets: {} }),
    getConfig: async () => fake.config,
    approveCompanion: (id: string) => fake.approve(id),
    refuseCompanion: (id: string) => fake.refuse(id),
  },
}))
vi.mock('../src/shared/theme', () => ({ useConfigTheme: () => {}, followThemeSchedule: () => () => {} }))

function push(channel: string, data: unknown): void {
  fake.subs.get(channel)?.forEach((cb) => cb(data))
}

const NOW = 1_000_000
const pairing = (over: Record<string, unknown> = {}) =>
  ({ requestId: 'r1', code: 'K7M2', name: 'Companion on Chrome', expiresAt: NOW + 120_000, ...over })

describe('the pairing prompt', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); fake.approve.mockClear(); fake.refuse.mockClear() })
  afterEach(() => { vi.useRealTimers() })

  async function mountPrompt(p: unknown) {
    const { default: CompanionPrompt } = await import('../src/dashboard/CompanionPrompt.vue')
    return mount(CompanionPrompt, { props: { pairing: p as never } })
  }

  it('shows the code and name and calls approve on Autoriser', async () => {
    const w = await mountPrompt(pairing())
    expect(w.text()).toContain('K7M2')
    expect(w.text()).toContain('Companion on Chrome')
    await w.find('button.approve').trigger('click')
    expect(fake.approve).toHaveBeenCalledWith('r1')
    expect(fake.refuse).not.toHaveBeenCalled()
  })

  it('calls refuse on Refuser', async () => {
    const w = await mountPrompt(pairing())
    await w.find('button.refuse').trigger('click')
    expect(fake.refuse).toHaveBeenCalledWith('r1')
  })

  it('shows a short error in the prompt when the answer fails', async () => {
    fake.approve.mockRejectedValueOnce(new Error('HTTP 404'))
    const w = await mountPrompt(pairing())
    await w.find('button.approve').trigger('click')
    await flushPromises()
    expect(w.find('.error').exists()).toBe(true)
  })

  it('keeps the buttons disabled after an answer went through, until another request comes', async () => {
    fake.approve.mockResolvedValue(undefined)
    const w = await mountPrompt(pairing())
    await w.find('button.approve').trigger('click')
    await flushPromises()
    expect(w.find('button.approve').attributes('disabled')).toBeDefined()
    expect(w.find('button.refuse').attributes('disabled')).toBeDefined()
    // A second tap before the snapshot hides the prompt sends nothing and shows no error.
    await w.find('button.approve').trigger('click')
    await flushPromises()
    expect(fake.approve).toHaveBeenCalledTimes(1)
    expect(w.find('.error').exists()).toBe(false)
    // The same request with a new deadline is still answered; a new request frees the buttons.
    await w.setProps({ pairing: pairing({ expiresAt: NOW + 60_000 }) as never })
    expect(w.find('button.approve').attributes('disabled')).toBeDefined()
    await w.setProps({ pairing: pairing({ requestId: 'r2' }) as never })
    expect(w.find('button.approve').attributes('disabled')).toBeUndefined()
  })

  it('frees the buttons after a failure, to try again', async () => {
    fake.approve.mockRejectedValueOnce(new Error('HTTP 500'))
    const w = await mountPrompt(pairing())
    await w.find('button.approve').trigger('click')
    await flushPromises()
    expect(w.find('button.approve').attributes('disabled')).toBeUndefined()
  })

  it('hides at expiresAt even before the next snapshot', async () => {
    const w = await mountPrompt(pairing())
    expect(w.find('.companion-prompt').exists()).toBe(true)
    vi.advanceTimersByTime(120_001)
    await nextTick()
    expect(w.find('.companion-prompt').exists()).toBe(false)
  })

  it('renders nothing for a request already expired', async () => {
    const w = await mountPrompt(pairing({ expiresAt: NOW - 1 }))
    expect(w.find('.companion-prompt').exists()).toBe(false)
  })
})

describe('the reveal tracker', () => {
  const snap = (seq: number, screenId = 'edge', pageIndex = 1) => ({ reveal: { seq, screenId, pageIndex } })

  it('records the first snapshot without acting', () => {
    const t = createRevealTracker()
    expect(t.observe(snap(4), 'edge')).toBeNull()
  })

  it('selects the page once per seq, and again when the seq differs (a restart)', () => {
    const t = createRevealTracker()
    t.observe({ reveal: null }, 'edge')
    expect(t.observe(snap(1, 'edge', 2), 'edge')).toBe(2)
    expect(t.observe(snap(1, 'edge', 2), 'edge')).toBeNull()
    expect(t.observe(snap(2, 'edge', 0), 'edge')).toBe(0)
    t.observe({ reveal: null }, 'edge')
    expect(t.observe(snap(1, 'edge', 3), 'edge')).toBe(3)
  })

  it('ignores a reveal for another screen', () => {
    const t = createRevealTracker()
    t.observe({ reveal: null }, 'edge')
    expect(t.observe(snap(1, 'pad'), 'edge')).toBeNull()
  })

  it('does not act on a reconnect snapshot after reset', () => {
    const t = createRevealTracker()
    t.observe({ reveal: null }, 'edge')
    t.reset()
    expect(t.observe(snap(7), 'edge')).toBeNull()
    expect(t.observe(snap(8), 'edge')).toBe(1)
  })
})

describe('the dashboard and the companion channel', () => {
  const config = (): Config => ({
    version: 4, theme: 'fremkit', connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {},
    screens: [{
      id: 'edge', name: 'edge', kind: 'edge',
      display: { cols: 20, rows: 10, cell: 40, autoCycleSeconds: 0 }, nav: [],
      pages: [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}`, items: [] })),
    }],
  } as unknown as Config)
  const PageStub = defineComponent({
    props: { page: { type: Object, required: true } },
    setup: (props) => () => h('div', { class: 'page-stub' }, (props.page as { id: string }).id),
  })

  async function mountApp(href: string) {
    const url = new URL(href)
    vi.stubGlobal('location', { protocol: url.protocol, search: url.search, host: url.host, href: url.href, reload: vi.fn() })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"id":"d1","name":"Pad","screenId":"edge"}', { status: 200 })))
    const { default: App } = await import('../src/dashboard/App.vue')
    const wrapper = mount(App, { global: { stubs: { PageView: PageStub } }, attachTo: document.body })
    await flushPromises(); await nextTick()
    return wrapper
  }

  beforeEach(() => { vi.resetModules(); fake.subs.clear(); fake.config = config() })
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

  const state = (over: Record<string, unknown>) => ({ pairing: null, reveal: null, ...over })

  it('a reveal for this screen selects its page once per seq', async () => {
    const w = await mountApp('http://127.0.0.1:4242/')
    push('companion', state({}))
    push('companion', state({ reveal: { seq: 1, screenId: 'edge', pageIndex: 2 } }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p2')
    w.unmount()
  })

  it('a reload with a share already revealed does not jump', async () => {
    const w = await mountApp('http://127.0.0.1:4242/')
    push('companion', state({ reveal: { seq: 3, screenId: 'edge', pageIndex: 2 } }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p0')
    w.unmount()
  })

  it('a reveal for another screen does nothing', async () => {
    const w = await mountApp('http://127.0.0.1:4242/')
    push('companion', state({}))
    push('companion', state({ reveal: { seq: 1, screenId: 'other', pageIndex: 2 } }))
    await nextTick()
    expect(w.find('.page-stub').text()).toBe('p0')
    w.unmount()
  })

  it('a remote page never subscribes to the channel', async () => {
    const w = await mountApp('https://example.local:4243/')
    expect(fake.subs.get('companion')?.size ?? 0).toBe(0)
    w.unmount()
  })

  it('shows the prompt while a request is pending and drops it when it leaves the snapshot', async () => {
    const w = await mountApp('http://127.0.0.1:4242/')
    push('companion', state({ pairing: { requestId: 'r1', code: 'K7M2', name: 'Companion', expiresAt: Date.now() + 60_000 } }))
    await nextTick()
    expect(w.find('.companion-prompt').exists()).toBe(true)
    push('companion', state({}))
    await nextTick()
    expect(w.find('.companion-prompt').exists()).toBe(false)
    w.unmount()
  })
})
