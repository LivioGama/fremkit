/**
 * @vitest-environment jsdom
 *
 * iPad pairing and extra screens as an experimental feature: what the admin hides while
 * `labs.devices` is off (the Devices section, the screen selector and its "Add a screen" for a
 * single screen), the seven clicks on the version that reveal the switch, and the switch itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Config, Screen } from '../src/shared/types'

vi.mock('../src/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/api')>()
  return { ...actual, api: { ...actual.api, getDevices: vi.fn(async () => { throw new Error('offline') }) } }
})

const { default: ScreenSelector } = await import('../src/admin/ScreenSelector.vue')
const { default: ScreenInspector } = await import('../src/admin/ScreenInspector.vue')
const { useAdminStore } = await import('../src/admin/store')
const labs = await import('../src/admin/labs')

const screen = (id: string, kind: Screen['kind'] = 'edge'): Screen => ({
  id, name: id.toUpperCase(), kind, display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
  nav: [], pages: [{ id: 'home', name: 'Home', items: [] }],
})

function config(devices: boolean | undefined, count: number): Config {
  return {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    ...(devices === undefined ? {} : { labs: { devices } }),
    widgets: {},
    screens: [screen('edge'), ...(count > 1 ? [screen('kitchen', 'device')] : [])],
  }
}

const stubs = {
  PageView: { template: '<div class="page-stub" />' },
  DevicesSection: true, NavWidgetsEditor: true, BackgroundPicker: true, DiagnosticsSection: true, HistorySection: true,
}

function seed(devices: boolean | undefined, count: number): void {
  const s = useAdminStore()
  s.state.config = config(devices, count)
  s.state.manifests = {}
  s.state.toast = ''
  s.selectScreen('edge')
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
    new Response(url === '/api/themes' ? '{"themes":{},"errors":[]}' : init?.body ?? '{}',
      { headers: { 'content-type': 'application/json' } })))
  labs.resetLabsReveal()
})

afterEach(async () => {
  const s = useAdminStore()
  await s.flush()
  s.state.config = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('what the flag shows', () => {
  it('reads an absent flag as off', () => {
    expect(labs.labsDevices(config(undefined, 1))).toBe(false)
    expect(labs.labsDevices(null)).toBe(false)
  })

  for (const devices of [false, true]) {
    for (const count of [1, 2]) {
      const selector = devices || count > 1
      it(`flag ${devices ? 'on' : 'off'}, ${count} screen(s): selector ${selector ? 'shown' : 'hidden'}, Devices ${devices ? 'shown' : 'hidden'}`, async () => {
        seed(devices, count)
        expect(labs.showsScreens(config(devices, count))).toBe(selector)

        const sel = mount(ScreenSelector, { attachTo: document.body, global: { stubs } })
        expect(sel.find('nav.screens').exists()).toBe(selector)
        expect(sel.find('button.add').exists()).toBe(selector)
        sel.unmount()

        const insp = mount(ScreenInspector, { attachTo: document.body, global: { stubs } })
        await flushPromises()
        expect(insp.find('[data-section="screen.devices"]').exists()).toBe(devices)
        insp.unmount()
      })
    }
  }
})

describe('the seven clicks on the version', () => {
  it('reveal nothing before the seventh, then reveal once', () => {
    for (let i = 1; i < labs.REVEAL_TAPS; i++) expect(labs.tapVersion(1000 + i * 100)).toBe(false)
    expect(labs.labsShown(config(false, 1))).toBe(false)
    expect(labs.tapVersion(1700)).toBe(true)
    expect(labs.labsShown(config(false, 1))).toBe(true)
    expect(labs.tapVersion(1800)).toBe(false)
  })

  it('start over when they are too slow', () => {
    for (let i = 0; i < labs.REVEAL_TAPS - 1; i++) labs.tapVersion(i * 100)
    // The seventh comes after the window: it counts as the first of a new series.
    expect(labs.tapVersion(labs.REVEAL_WINDOW_MS + 1)).toBe(false)
    for (let i = 1; i < labs.REVEAL_TAPS - 1; i++) expect(labs.tapVersion(labs.REVEAL_WINDOW_MS + 1 + i * 100)).toBe(false)
    expect(labs.tapVersion(labs.REVEAL_WINDOW_MS + 1 + (labs.REVEAL_TAPS - 1) * 100)).toBe(true)
  })

  it('show the switch in About with a toast, and the switch writes the flag', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T08:00:00Z'))
    seed(false, 1)
    const s = useAdminStore()
    const wrapper = mount(ScreenInspector, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    const version = wrapper.find('[data-test="version"]')
    // Not a control: no tab stop, no role, nothing for the keyboard to land on.
    expect(version.element.tagName).toBe('P')
    expect(version.attributes('tabindex')).toBeUndefined()
    for (let i = 0; i < labs.REVEAL_TAPS - 1; i++) await version.trigger('click')
    expect(wrapper.find('[data-test="labs-devices"]').exists()).toBe(false)
    await version.trigger('click')
    await flushPromises()
    const box = wrapper.find('[data-test="labs-devices"] input')
    // The box takes the focus, which scrolls it into view and announces it; no error toast.
    expect(document.activeElement).toBe(box.element)
    expect(s.state.toast).toBe('')
    expect(wrapper.text()).toMatch(/Experimental features|Fonctions expérimentales/)
    expect((box.element as HTMLInputElement).checked).toBe(false)

    await box.setValue(true)
    expect(s.state.config!.labs).toEqual({ devices: true })
    expect(wrapper.find('[data-section="screen.devices"]').exists()).toBe(true)
    await box.setValue(false)
    expect(s.state.config!.labs).toEqual({ devices: false })
    expect(wrapper.find('[data-section="screen.devices"]').exists()).toBe(false)
    // Still there once turned off in this session, so it can be turned back on.
    expect(wrapper.find('[data-test="labs-devices"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('leave the switch in sight while the flag is on, revealed or not', async () => {
    seed(true, 1)
    const wrapper = mount(ScreenInspector, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    const box = wrapper.find('[data-test="labs-devices"] input')
    expect((box.element as HTMLInputElement).checked).toBe(true)
    await box.setValue(false)
    expect(useAdminStore().state.config!.labs).toEqual({ devices: false })
    wrapper.unmount()
  })
})
