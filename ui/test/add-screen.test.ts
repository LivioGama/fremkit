/**
 * @vitest-environment jsdom
 *
 * Adding a screen, rendered: the selector lists the screens and opens the dialog; a pre-fill
 * goes through a preview that names what is left out, and nothing is saved before Accept.
 *
 * The store is a module singleton built against the real `api`, so its state is seeded directly
 * and the save it schedules is answered by a stubbed fetch. Page drawings are stubbed: they would
 * load every widget in an iframe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AddScreenDialog from '../src/admin/AddScreenDialog.vue'
import ScreenSelector from '../src/admin/ScreenSelector.vue'
import { useAdminStore } from '../src/admin/store'
import type { Config, WidgetManifest } from '../src/shared/types'

const manifest = (id: string, name: string, minSize: [number, number]): WidgetManifest => ({
  id, name: { fr: name, en: name }, version: '1.0.0', sdk: 1,
  description: { fr: '', en: '' }, icon: 'clock',
  minSize, defaultSize: minSize,
  subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
})

/** The Edge with a clock and a banner too wide for any iPad (40 columns at the least). */
function config(): Config {
  return {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {
      'clock-1': { widgetId: 'clock', showTitle: true, settings: {} },
      'banner-1': { widgetId: 'banner', showTitle: true, settings: {} },
    },
    screens: [{
      id: 'edge', name: 'Edge', kind: 'edge',
      display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
      nav: [],
      pages: [{ id: 'home', name: 'Home', items: [
        { instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 },
        { instanceId: 'banner-1', x: 8, y: 0, w: 48, h: 4 },
      ] }],
    }],
  }
}

const stubs = { PageView: { template: '<div class="page-stub" />' } }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
    new Response(init?.body ?? '{}', { headers: { 'content-type': 'application/json' } })))
  const s = useAdminStore()
  s.state.config = config()
  s.state.manifests = { clock: manifest('clock', 'Clock', [4, 2]), banner: manifest('banner', 'Banner', [40, 4]) }
  s.selectScreen('edge')
})

afterEach(async () => {
  const s = useAdminStore()
  await s.flush()
  s.state.config = null
  s.state.manifests = {}
  vi.unstubAllGlobals()
})

const button = (wrapper: ReturnType<typeof mount>, text: string) =>
  wrapper.findAll('button').find((b) => b.text() === text)!

describe('the add-screen dialog', () => {
  it('previews a pre-fill, names what is left out, and saves only on Accept', async () => {
    const s = useAdminStore()
    const wrapper = mount(AddScreenDialog, { attachTo: document.body, global: { stubs } })
    await wrapper.find('input').setValue('Kitchen')
    const selects = wrapper.findAll('select')
    expect(selects[0].findAll('option').map((o) => o.text())).toEqual([
      'iPad Pro 13" landscape — 1376 × 1032', 'iPad Pro 13" portrait — 1032 × 1376',
      'iPad Pro 11" landscape — 1210 × 834', 'iPad Pro 11" portrait — 834 × 1210',
      'iPad Air 13" landscape — 1366 × 1024', 'iPad Air 13" portrait — 1024 × 1366',
      'iPad Air 11" landscape — 1180 × 820', 'iPad Air 11" portrait — 820 × 1180',
      'Custom',
    ])
    expect(wrapper.text()).toContain('“More Space” is larger')
    // The grid hint names the bar the device screen will get.
    expect(wrapper.find('.hint:not(.bad)').exists()).toBe(true)
    expect(wrapper.text()).toContain('Grid: 34 × 24 cells under a 40 px bar.')
    await selects[1].setValue('edge')
    await button(wrapper, 'Preview…').trigger('click')

    expect(s.state.config!.screens).toHaveLength(1)
    // Under the 40 px bar a device screen starts with: the preview counts the rows addScreen will.
    expect(wrapper.text()).toContain('1 page(s), on a 34 × 24 grid.')
    expect(wrapper.text()).toContain('The look (background, opacities, rotation, admin gesture) is copied from Edge.')
    expect(wrapper.find('[data-test="left-out"]').text()).toContain('Left out, for lack of room: Banner.')
    expect(wrapper.findAll('.page-stub')).toHaveLength(1)

    await button(wrapper, 'Accept').trigger('click')
    const added = s.state.config!.screens[1]
    expect(added).toMatchObject({ id: 'kitchen', name: 'Kitchen', kind: 'device', display: { cols: 34, rows: 24, navHeight: 40, orientation: 'landscape' } })
    expect(added.pages[0].items).toEqual([{ instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 }])
    expect(s.state.screenId).toBe('kitchen')
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('refuses a custom size too small for one cell', async () => {
    const s = useAdminStore()
    const wrapper = mount(AddScreenDialog, { attachTo: document.body, global: { stubs } })
    await wrapper.findAll('select')[0].setValue('custom')
    const [w, h] = wrapper.findAll('input[type="number"]')
    await w.setValue('30')
    await h.setValue('800')
    expect(wrapper.find('.hint.bad').exists()).toBe(true)
    expect(button(wrapper, 'Add').attributes('disabled')).toBeDefined()
    await h.setValue('800')
    await w.setValue('800')
    expect(button(wrapper, 'Add').attributes('disabled')).toBeUndefined()
    await button(wrapper, 'Add').trigger('click')
    expect(s.state.config!.screens[1].display).toMatchObject({ cols: 20, rows: 19, navHeight: 40, viewport: { width: 800, height: 800 } })
    wrapper.unmount()
  })
})

describe('the screen selector', () => {
  it('is a segmented control up to three screens and a menu beyond', async () => {
    const s = useAdminStore()
    const wrapper = mount(ScreenSelector, { attachTo: document.body, global: { stubs } })
    expect(wrapper.findAll('[role="tab"]').map((b) => b.text())).toEqual(['Edge'])
    expect(wrapper.text()).toContain('+ Add a screen')
    for (const name of ['A', 'B', 'C']) s.addScreen({ name, kind: 'edge', prefill: null })
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(0)
    await wrapper.find('.trigger').trigger('click')
    expect(wrapper.findAll('[role="option"]').map((o) => o.text())).toEqual(['Edge', 'A', 'B', 'C'])
    await wrapper.findAll('[role="option"] button')[0].trigger('click')
    expect(s.state.screenId).toBe('edge')
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
