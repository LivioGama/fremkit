/**
 * @vitest-environment jsdom
 *
 * The pieces of the editor that show widget health: the inspector's banner, the dots on the
 * pages and screens, and the fix the menus lead with.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setLocale } from '../src/shared/i18n'
import HealthBanner from '../src/admin/HealthBanner.vue'
import HealthDot from '../src/admin/HealthDot.vue'
import { widgetMenu, type MenuUi } from '../src/admin/canvasMenu'
import { navWidgetMenu } from '../src/admin/menus'
import { createAdminStore } from '../src/admin/store'
import { isSeparator, type MenuItem } from '../src/shared/ui/contextMenu'
import type { InstanceHealth } from '../src/admin/health'
import type { Config, WidgetManifest } from '../src/shared/types'

beforeEach(() => setLocale('en'))

const broken: InstanceHealth = {
  level: 'error',
  problems: [
    { level: 'error', code: 'unauthorized', action: { kind: 'connection', id: 'gh-work' } },
    { level: 'warning', code: 'update', action: { kind: 'update', widgetId: 'gh' } },
  ],
}

describe('the inspector banner', () => {
  it('says what is wrong, lists the rest, and offers the first fix', async () => {
    const wrapper = mount(HealthBanner, { props: { health: broken } })
    expect(wrapper.classes()).toContain('error')
    expect(wrapper.text()).toContain('refuses the credentials')
    expect(wrapper.text()).toContain('An update is available.')
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].text()).toBe('Open the connection')
    await buttons[0].trigger('click')
    expect(wrapper.emitted('action')?.[0]).toEqual([{ kind: 'connection', id: 'gh-work' }])
  })

  it('reads in French too', () => {
    setLocale('fr')
    const wrapper = mount(HealthBanner, { props: { health: broken } })
    expect(wrapper.text()).toContain('refuse les identifiants')
    expect(wrapper.get('button').text()).toBe('Ouvrir la connexion')
  })

  it('has no button for a problem with nothing to press', () => {
    const wrapper = mount(HealthBanner, { props: { health: { level: 'warning', problems: [{ level: 'warning', code: 'offline', action: null }] } } })
    expect(wrapper.classes()).toContain('warning')
    expect(wrapper.find('button').exists()).toBe(false)
  })
})

describe('the dot', () => {
  it('is drawn only when something is wrong', () => {
    expect(mount(HealthDot, { props: { level: 'ok' } }).find('.health-dot').exists()).toBe(false)
    const dot = mount(HealthDot, { props: { level: 'warning', title: 'A widget on this page needs attention' } }).get('.health-dot')
    expect(dot.classes()).toContain('warning')
    expect(dot.attributes('aria-label')).toBe('A widget on this page needs attention')
  })
})

describe('the menus', () => {
  const clock: WidgetManifest = {
    id: 'clock', name: 'Clock', version: '1.0.0', sdk: 1, description: '', icon: 'clock',
    minSize: [8, 4], defaultSize: [16, 4], subscriptions: [], commands: [],
    settingsSchema: {}, permissions: { network: [] }, compact: { width: 4 },
  }
  const cfg = (): Config => ({
    version: 4, locale: 'en', connections: [], secrets: { backend: 'file' },
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {
      'clock-1': { widgetId: 'clock', showTitle: true, settings: {} },
      'bar-1': { widgetId: 'clock', showTitle: false, settings: {} },
    },
    screens: [{
      id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
      nav: [{ instanceId: 'bar-1', slot: 'left' }],
      pages: [{ id: 'a', name: 'Home', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }] }],
    }],
  })
  async function store() {
    const s = createAdminStore({
      api: {
        getConfig: async () => cfg(), getStatus: async () => ({ degraded: false }),
        getWidgets: async () => ({ widgets: { clock }, errors: [], sources: {}, asks: {}, sdk: 1 }),
        putConfig: async (c) => c, rescan: async () => ({ widgets: { clock }, errors: [], sources: {}, asks: {}, sdk: 1 }),
      },
      subscribeConfig: () => () => {},
      debounceMs: 0,
    })
    await s.load()
    return s
  }

  it('lead with the fix of a tile or a bar widget that is not well', async () => {
    const s = await store()
    const run = vi.fn()
    const ui: MenuUi = {
      revealSection: vi.fn(), focusLibrarySearch: vi.fn(),
      fix: (id) => (id === 'clock-1' || id === 'bar-1' ? { label: 'Fix: Reload the widget', run } : null),
    }
    for (const menu of [widgetMenu(s, 'clock-1', ui), navWidgetMenu(s, 'bar-1', ui)]) {
      expect((menu[0] as MenuItem).label).toBe('Fix: Reload the widget')
      expect(isSeparator(menu[1])).toBe(true)
    }
    ;(widgetMenu(s, 'clock-1', ui)[0] as MenuItem).run?.()
    expect(run).toHaveBeenCalledOnce()
  })

  it('start as before for a widget that is well, or without a health source', async () => {
    const s = await store()
    const well: MenuUi = { revealSection: vi.fn(), focusLibrarySearch: vi.fn(), fix: () => null }
    const none: MenuUi = { revealSection: vi.fn(), focusLibrarySearch: vi.fn() }
    for (const ui of [well, none]) {
      expect((widgetMenu(s, 'clock-1', ui)[0] as MenuItem).label).toBe('Settings…')
    }
  })
})
