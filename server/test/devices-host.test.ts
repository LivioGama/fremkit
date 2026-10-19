import { describe, expect, it } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import { defaultRouteInterface, isPrivate, lanAddresses, pickAddress, type InterfaceMap } from '../src/devices/host.js'

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: null,
})
const v6 = (address: string): NetworkInterfaceInfo => ({
  address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: null, scopeid: 0,
})

const IFACES: InterfaceMap = {
  lo0: [v4('127.0.0.1', true), v6('::1')],
  // Tailscale and a link-local fallback: never reachable from the LAN.
  utun4: [v4('100.100.1.2')],
  en5: [v4('169.254.10.20')],
  // A VPN that sorts first.
  utun2: [v4('10.0.0.5')],
  bridge100: [v4('192.0.2.1')],
  en1: [v4('198.51.100.7')],
  en0: [v4('10.20.0.30'), v6('fe80::1')],
}

describe('lanAddresses', () => {
  it('keeps external IPv4 only, without link-local or carrier-grade NAT', () => {
    expect(lanAddresses(IFACES)).toEqual(['10.0.0.5', '10.20.0.30', '192.0.2.1', '198.51.100.7'])
  })

  it('drops all of 100.64/10 and 169.254/16, and nothing beside them', () => {
    const list = lanAddresses({
      a: [v4('100.64.0.1'), v4('100.127.255.254'), v4('169.254.0.1')],
      b: [v4('100.63.255.255'), v4('100.128.0.1'), v4('169.253.0.1')],
    })
    expect(list).toEqual(['100.128.0.1', '100.63.255.255', '169.253.0.1'])
  })
})

describe('pickAddress', () => {
  const all = lanAddresses(IFACES)

  it('prefers the default-route interface', () => {
    expect(pickAddress(all, IFACES, 'en1')).toBe('198.51.100.7')
    expect(pickAddress(all, IFACES, 'bridge100')).toBe('192.0.2.1')
  })

  it('then a private address on an en* interface', () => {
    expect(pickAddress(all, IFACES, null)).toBe('10.20.0.30')
    // A default route through an interface with no usable address falls through too.
    expect(pickAddress(all, IFACES, 'utun4')).toBe('10.20.0.30')
  })

  it('then the first address left', () => {
    const ifaces: InterfaceMap = { utun2: [v4('10.0.0.5')], en1: [v4('198.51.100.7')] }
    expect(pickAddress(lanAddresses(ifaces), ifaces, null)).toBe('10.0.0.5')
    expect(pickAddress([], {}, null)).toBeNull()
  })

  it('only ever picks one of the addresses it was given', () => {
    expect(pickAddress(['192.0.2.1'], IFACES, 'en0')).toBe('192.0.2.1')
    expect(pickAddress(['192.0.2.10'], IFACES, 'en0')).toBe('192.0.2.10')
  })
})

describe('defaultRouteInterface', () => {
  it('reads the interface line of route -n get default', async () => {
    const calls: [string, string[]][] = []
    const out = '   route to: default\ndestination: default\n    gateway: 192.0.2.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>\n'
    expect(await defaultRouteInterface(async (cmd, args) => {
      calls.push([cmd, args])
      return { stdout: out }
    })).toBe('en0')
    expect(calls).toEqual([['/sbin/route', ['-n', 'get', 'default']]])
  })

  it('is null with no default route or an odd answer', async () => {
    expect(await defaultRouteInterface(async () => { throw new Error('not in table') })).toBeNull()
    expect(await defaultRouteInterface(async () => ({ stdout: 'route: writing to routing socket: not in table\n' }))).toBeNull()
    expect(await defaultRouteInterface(async () => ({ stdout: '  interface: en0;rm\n' }))).toBeNull()
  })
})

describe('isPrivate', () => {
  it('is RFC 1918 and nothing else', () => {
    for (const a of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.0.1']) expect(isPrivate(a), a).toBe(true)
    for (const a of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '100.64.0.1', '169.254.1.1', '192.0.2.10', '198.51.100.7', '127.0.0.1']) {
      expect(isPrivate(a), a).toBe(false)
    }
  })
})
