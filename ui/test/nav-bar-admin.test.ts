/**
 * @vitest-environment jsdom
 *
 * What the bar *does* with the events, rather than what its source says.
 *
 * Four paths open the admin, because each is the only real one somewhere: the right button for the
 * helper's web view, `contextmenu` for a mouse, the taps counted in the page for the panel,
 * `dblclick` for a browser that does synthesise one. The question no reading of the source answers
 * is what happens where two of them are real *at the same time* — a desktop browser, the Chrome
 * kiosk — and the answer used to be two admin windows for one press.
 *
 * So the bar is mounted and the events are dispatched as the real ones arrive, in order.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import NavBar from '../src/dashboard/NavBar.vue'
import { pickScreen } from '../src/shared/screens'
import { navItemsOf, type AdminGesture, type Config, type Page, type Screen, type WidgetManifest } from '../src/shared/types'

const PAGES: Page[] = [
  { id: 'home', name: 'Accueil', items: [] },
  { id: 'work', name: 'Travail', items: [] },
]

function bar(adminGesture?: AdminGesture) {
  const wrapper = mount(NavBar, {
    props: { pages: PAGES, active: 0, height: 64, ...(adminGesture ? { adminGesture } : {}) },
    attachTo: document.body,
  })
  const dots = wrapper.find('.dots').element
  /** A pointer event as the page receives it: jsdom has no PointerEvent, and none of this reads one. */
  const down = (button = 0, x = 100, y = 30): void => {
    dots.dispatchEvent(new MouseEvent('pointerdown', { button, clientX: x, clientY: y, bubbles: true, cancelable: true }))
  }
  const fire = (type: string): void => {
    dots.dispatchEvent(new MouseEvent(type, { clientX: 100, clientY: 30, bubbles: true, cancelable: true }))
  }
  const admins = (): number => wrapper.emitted('admin')?.length ?? 0
  return { wrapper, down, fire, admins }
}

describe('the dots open the admin once per gesture', () => {
  it('counts a right click as one, not as a button and a context menu', () => {
    // Both arrive in a browser: the button event this listens for because the helper's web view
    // delivers nothing else, then WebKit's own `contextmenu`. One press, one window.
    const { wrapper, down, fire, admins } = bar()
    down(2)
    fire('contextmenu')
    expect(admins()).toBe(1)
    wrapper.unmount()
  })

  it('counts a double tap as one, not as two taps and a double click', () => {
    const { wrapper, down, fire, admins } = bar()
    down(0)
    down(0)
    fire('dblclick')
    expect(admins()).toBe(1)
    wrapper.unmount()
  })

  it('opens nothing on a single tap', () => {
    const { wrapper, down, fire, admins } = bar()
    down(0)
    fire('pointerup')
    expect(admins()).toBe(0)
    wrapper.unmount()
  })

  it('opens nothing on two taps far enough apart to be two taps', () => {
    const { wrapper, down, admins } = bar()
    down(0, 100, 30)
    // Past DOUBLE_TAP_SLOP: two different dots, two separate taps.
    down(0, 400, 30)
    expect(admins()).toBe(0)
    wrapper.unmount()
  })
})

describe('the setting decides which gesture is listened to', () => {
  it('ignores the double tap when the setting is the long press', () => {
    const { wrapper, down, fire, admins } = bar('longPress')
    down(0)
    down(0)
    fire('dblclick')
    expect(admins()).toBe(0)
    // The long press still works, and still only once.
    down(2)
    fire('contextmenu')
    expect(admins()).toBe(1)
    wrapper.unmount()
  })

  it('ignores the long press when the setting is the double tap', () => {
    const { wrapper, down, fire, admins } = bar('doubleTap')
    down(2)
    fire('contextmenu')
    expect(admins()).toBe(0)
    down(0)
    down(0)
    expect(admins()).toBe(1)
    wrapper.unmount()
  })
})

describe('the bar of one screen', () => {
  const manifest = (id: string): WidgetManifest => ({
    id, name: id, version: '1.0.0', sdk: 1, description: '', icon: 'clock',
    minSize: [4, 2], defaultSize: [8, 4], compact: { width: 3 },
    subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
  })
  const screen = (id: string, kind: Screen['kind'], nav: Screen['nav']): Screen => ({
    id, name: id, kind, display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav, pages: PAGES,
  })
  const config = {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {
      'clock-1': { widgetId: 'clock', showTitle: false, settings: {} },
      'weather-1': { widgetId: 'weather', showTitle: false, settings: {} },
      'battery-1': { widgetId: 'battery', showTitle: false, settings: {} },
    },
    screens: [
      screen('edge', 'edge', [{ instanceId: 'clock-1', slot: 'left' }, { instanceId: 'weather-1', slot: 'right' }]),
      screen('ipad', 'device', [{ instanceId: 'battery-1', slot: 'right' }]),
    ],
  } as unknown as Config
  const manifests = { clock: manifest('clock'), weather: manifest('weather'), battery: manifest('battery') }

  function srcs(id: string | null): string[] {
    const navItems = navItemsOf(pickScreen(config, id))
    const wrapper = mount(NavBar, {
      props: { pages: PAGES, active: 0, height: 80, navItems, widgets: config.widgets, manifests },
    })
    const out = wrapper.findAll('.compact iframe').map((f) => f.attributes('src') ?? '')
    wrapper.unmount()
    return out
  }

  it('renders the bar items of the given screen only', () => {
    expect(srcs('ipad')).toEqual(['/widgets/battery/index.html'])
    expect(srcs('edge')).toEqual(['/widgets/clock/index.html', '/widgets/weather/index.html'])
    // A stale id shows the Edge's bar, never an empty one.
    expect(srcs('gone')).toEqual(['/widgets/clock/index.html', '/widgets/weather/index.html'])
  })

  it('sizes each item from its shared widget', () => {
    const wrapper = mount(NavBar, {
      props: { pages: PAGES, active: 0, height: 80, navItems: navItemsOf(pickScreen(config, 'ipad')), widgets: config.widgets, manifests, cell: 40 },
    })
    expect((wrapper.find('.compact').element as HTMLElement).style.width).toBe('120px')
    wrapper.unmount()
  })
})

describe('the dots fit the room kept for them', () => {
  const pages = (n: number): Page[] => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, items: [] }))
  /** The hit column each dot gets, as the bar hands it to its stylesheet; 80 px is full scale. */
  function column(n: number, height = 80): string {
    const wrapper = mount(NavBar, { props: { pages: pages(n), active: 0, height, cell: 40 } })
    const width = (wrapper.find('nav').element as HTMLElement).style.getPropertyValue('--dot-width')
    wrapper.unmount()
    return width
  }

  it('keeps the 64 px columns when the pages fit, as on the Edge', () => {
    expect(column(4)).toBe('64px')
  })

  it('narrows the columns to share the reserved cells between many pages', () => {
    // 10 cells x 40 px = 400 px for 8 dots.
    expect(column(8)).toBe('50px')
  })

  it('never goes under the 44 px touch minimum', () => {
    expect(column(12)).toBe('44px')
  })

  it('keeps the touch minimum on a slim bar, where only the visible dot shrinks', () => {
    // 64 x 0.5 = 32 px would be under the minimum: the column stays 44 real px.
    expect(column(4, 40)).toBe('44px')
    expect(column(8, 40)).toBe('44px')
  })
})
