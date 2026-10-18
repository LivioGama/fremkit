import { describe, it, expect } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG, type Config } from '../src/config/schema.js'
import { channelAllowed, HOST_CHANNELS, screenChannels, type ChannelManifest } from '../src/devices/channels.js'

const manifests = new Map<string, ChannelManifest>([
  ['spotify', { subscriptions: ['spotify'], commands: ['spotify'] }],
  ['clock', {
    subscriptions: ['calendar:*'],
    commands: [],
    settingsSchema: { city: { preview: { channel: 'weather' } }, label: {} },
  }],
  ['system', { subscriptions: ['system'], commands: ['system-cmd'] }],
])

function config(): Config {
  return ConfigSchema.parse({
    ...structuredClone(DEFAULT_CONFIG),
    widgets: {
      'spotify-1': { widgetId: 'spotify', settings: {} },
      'clock-1': { widgetId: 'clock', settings: {} },
      'system-1': { widgetId: 'system', settings: {} },
      'ghost-1': { widgetId: 'not-installed', settings: {} },
    },
    screens: [
      {
        id: 'edge', name: 'Edge', kind: 'edge', nav: [],
        pages: [{ id: 'home', name: 'Home', items: [{ instanceId: 'spotify-1', x: 0, y: 0, w: 8, h: 4 }] }],
      },
      {
        id: 'tablet', name: 'Tablet', kind: 'device',
        nav: [{ instanceId: 'system-1', slot: 'left' }],
        pages: [
          { id: 'one', name: 'One', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 4, h: 2 }] },
          { id: 'two', name: 'Two', items: [{ instanceId: 'ghost-1', x: 0, y: 0, w: 4, h: 2 }] },
        ],
      },
    ],
  })
}

describe('screenChannels', () => {
  it('collects the channels of the widgets on the screen\'s pages and in its bar, and no other', () => {
    const channels = screenChannels(config(), 'tablet', manifests)
    expect(channels.subscriptions.sort()).toEqual(['calendar:*', 'system'])
    // `clock` names `weather` in a preview but not in `commands`: a manifest the schema refuses
    // today, and one that must not widen a device's policy even if it got through.
    expect(channels.commands.sort()).toEqual(['system-cmd'])
    expect(channels.subscriptions).not.toContain('spotify')
    expect(channels.commands).not.toContain('spotify')
  })

  it('gives the other screen its own widgets', () => {
    expect(screenChannels(config(), 'edge', manifests)).toEqual({ subscriptions: ['spotify'], commands: ['spotify'] })
  })

  it('gives an unknown screen nothing', () => {
    expect(screenChannels(config(), 'nowhere', manifests)).toEqual({ subscriptions: [], commands: [] })
  })
})

describe('channelAllowed', () => {
  it('matches a literal channel or a family wildcard, and nothing broader', () => {
    expect(channelAllowed(['system'], 'system')).toBe(true)
    expect(channelAllowed(['calendar:*'], 'calendar:ics-1')).toBe(true)
    expect(channelAllowed(['calendar:*'], 'calendar')).toBe(false)
    expect(channelAllowed(['calendar:*'], 'calendarx:1')).toBe(false)
    expect(channelAllowed(['system'], 'system:x')).toBe(false)
    expect(channelAllowed([], 'config')).toBe(false)
  })

  it('names config as the only host channel', () => {
    expect(HOST_CHANNELS).toEqual(['config'])
  })
})
