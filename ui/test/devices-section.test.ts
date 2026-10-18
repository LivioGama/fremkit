/**
 * @vitest-environment jsdom
 *
 * The Devices section, rendered against a mocked device api: the switch, the code while pairing
 * is open, the per-device screen picker, a screen made at a device's size, and the warning a
 * screen's removal gives about the devices showing it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { DeviceStatus, PublicDevice } from '../src/shared/api'
import type { Config } from '../src/shared/types'

const device = (over: Partial<PublicDevice> = {}): PublicDevice => ({
  id: 'dev-1', name: 'Kitchen iPad', pairedAt: '2026-10-01T08:00:00.000Z', lastSeen: null,
  viewport: { width: 1376, height: 1032 }, screenId: null, ...over,
})
const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  enabled: false, listening: false, error: null, guessing: false, host: 'mac.example.local',
  addresses: ['192.0.2.10'], port: 4243, keyHash: null, devices: [], ...over,
})

const deviceApi = vi.hoisted(() => ({
  getDevices: vi.fn(),
  setDevicesEnabled: vi.fn(),
  newPairingCode: vi.fn(),
  patchDevice: vi.fn(),
  deleteDevice: vi.fn(),
  deleteAllDevices: vi.fn(),
  resetDeviceCertificate: vi.fn(),
}))
vi.mock('../src/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/api')>()
  return { ...actual, api: { ...actual.api, ...deviceApi } }
})

const { default: DevicesSection } = await import('../src/admin/DevicesSection.vue')
const { default: ScreenInspector } = await import('../src/admin/ScreenInspector.vue')
const { useDevices } = await import('../src/admin/devices')
const { useAdminStore } = await import('../src/admin/store')

function config(): Config {
  return {
    version: 4,
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {},
    screens: [
      { id: 'edge', name: 'Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [], pages: [{ id: 'home', name: 'Home', items: [] }] },
      { id: 'kitchen', name: 'Kitchen', kind: 'device', display: { cols: 34, rows: 24, cell: 40, autoCycleSeconds: 0, navHeight: 40, viewport: { width: 1376, height: 1032 }, orientation: 'landscape' }, nav: [], pages: [{ id: 'home', name: 'Home', items: [] }] },
    ],
  }
}

const stubs = { PageView: { template: '<div class="page-stub" />' } }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
    new Response(url === '/api/themes' ? '{"themes":{},"errors":[]}' : init?.body ?? '{}',
      { headers: { 'content-type': 'application/json' } })))
  for (const fn of Object.values(deviceApi)) fn.mockReset()
  deviceApi.getDevices.mockResolvedValue(status())
  deviceApi.newPairingCode.mockResolvedValue({ code: 'ABCD2345', expiresAt: Date.now() + 300_000, url: 'fremkit://pair?p=4243&c=ABCD2345&k=x' })
  deviceApi.patchDevice.mockImplementation(async (id: string, patch: { screenId?: string | null }) => device({ id, screenId: patch.screenId ?? null }))
  const d = useDevices()
  d.status.value = null
  d.offer.value = null
  d.error.value = ''
  const s = useAdminStore()
  s.state.config = config()
  s.state.manifests = {}
  s.selectScreen('edge')
})

afterEach(async () => {
  const s = useAdminStore()
  await s.flush()
  s.state.config = null
  vi.unstubAllGlobals()
})

describe('the devices section', () => {
  it('turns pairing on, then shows a code and its QR', async () => {
    deviceApi.setDevicesEnabled.mockResolvedValue(status({ enabled: true, listening: true }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="pairing-code"]').exists()).toBe(false)
    await wrapper.find('input[type="checkbox"]').setValue(true)
    await flushPromises()
    expect(deviceApi.setDevicesEnabled).toHaveBeenCalledWith(true)
    expect(deviceApi.newPairingCode).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-test="pairing-code"]').text()).toBe('ABCD2345')
    expect(wrapper.find('.qr svg').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Someone is trying')
    wrapper.unmount()
  })

  it('says the port is taken and stays off', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ error: 'portInUse' }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('[data-test="port-in-use"]').text()).toContain('Port 4243 is already used')
    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    expect(deviceApi.newPairingCode).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('warns while someone is guessing codes', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ enabled: true, listening: true, guessing: true }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('Someone is trying random codes: the code is blocked for a minute.')
    wrapper.unmount()
  })

  it('attaches a device to the screen picked for it', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [device({ screenId: 'kitchen' })] }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    const select = wrapper.find('[data-test="device"] select')
    // Device screens only, and "No screen".
    expect(select.findAll('option').map((o) => o.text())).toEqual(['No screen', 'Kitchen'])
    await select.setValue('')
    await flushPromises()
    expect(deviceApi.patchDevice).toHaveBeenCalledWith('dev-1', { screenId: null })
    wrapper.unmount()
  })

  it('makes a screen at a device’s size and attaches the device to it', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [device()] }))
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('This iPad has no screen')
    await wrapper.find('[data-test="create-screen"]').trigger('click')
    expect((document.querySelector('form input') as HTMLInputElement).value).toBe('Kitchen iPad')
    expect(document.querySelector('[data-test="device-size"]')!.textContent).toBe('1376 × 1032 px')
    const add = [...document.querySelectorAll('form button')].find((b) => b.textContent?.trim() === 'Add') as HTMLButtonElement
    add.click()
    await flushPromises()
    const s = useAdminStore()
    expect(s.state.config!.screens[2]).toMatchObject({ id: 'kitchen-ipad', kind: 'device' })
    expect(deviceApi.patchDevice).toHaveBeenCalledWith('dev-1', { screenId: 'kitchen-ipad' })
    expect(document.querySelector('form')).toBeNull()
    wrapper.unmount()
  })

  it('removes a device on the second tap only', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [device()] }))
    deviceApi.deleteDevice.mockResolvedValue(undefined)
    const wrapper = mount(DevicesSection, { attachTo: document.body, global: { stubs } })
    await flushPromises()
    const remove = () => wrapper.find('[data-test="device"]').findAll('button').find((b) => /Remove|Confirm/.test(b.text()))!
    await remove().trigger('click')
    expect(deviceApi.deleteDevice).not.toHaveBeenCalled()
    expect(remove().text()).toBe('Confirm?')
    await remove().trigger('click')
    await flushPromises()
    expect(deviceApi.deleteDevice).toHaveBeenCalledWith('dev-1')
    wrapper.unmount()
  })
})

describe('removing a screen', () => {
  it('names the devices showing it', async () => {
    deviceApi.getDevices.mockResolvedValue(status({ devices: [device({ screenId: 'kitchen' })] }))
    const s = useAdminStore()
    s.selectScreen('kitchen')
    const wrapper = mount(ScreenInspector, {
      attachTo: document.body,
      global: { stubs: { ...stubs, DevicesSection: true, NavWidgetsEditor: true, BackgroundPicker: true } },
    })
    await flushPromises()
    await wrapper.findAll('button').find((b) => b.text() === 'Delete this screen')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="remove-devices"]').text()).toBe('These devices will be left without a screen: Kitchen iPad.')
    wrapper.unmount()
  })
})
