import { describe, expect, it, vi } from 'vitest'
import { createAdvertiser, type AdvertiserChild } from '../src/devices/bonjour.js'

function fakeChild(): AdvertiserChild & { kill: ReturnType<typeof vi.fn> } {
  const child = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => {
      child.signalCode = 'SIGTERM'
      return true
    }),
    on: vi.fn(),
  }
  return child
}

function setup(processes = '') {
  const child = fakeChild()
  const spawn = vi.fn(() => child)
  const kill = vi.fn()
  const exitHooks = new Set<() => void>()
  const onExit = vi.fn((cb: () => void) => {
    exitHooks.add(cb)
    return () => {
      exitHooks.delete(cb)
    }
  })
  const listProcesses = vi.fn(() => processes)
  const advertise = createAdvertiser({ platform: 'darwin', spawn, kill, onExit, listProcesses })
  return { child, spawn, kill, exitHooks, listProcesses, advertise }
}

describe('the Bonjour advertiser', () => {
  it('runs dns-sd with an argument list and kills it on stop', () => {
    const { child, spawn, exitHooks, advertise } = setup()
    const ad = advertise(4243)
    expect(spawn).toHaveBeenCalledWith('/usr/bin/dns-sd', ['-R', 'Fremkit', '_fremkit._tcp', 'local', '4243'])
    expect(exitHooks.size).toBe(1)
    ad.stop()
    expect(child.kill).toHaveBeenCalledTimes(1)
    // The exit hook goes with it, and a second stop does not signal a dead child again.
    expect(exitHooks.size).toBe(0)
    ad.stop()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('kills the child synchronously when the process exits', () => {
    const { child, exitHooks, advertise } = setup()
    advertise(4243)
    for (const hook of exitHooks) hook()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('kills a stale dns-sd for the same port, and only an exact match', () => {
    const { kill, spawn, listProcesses, advertise } = setup([
      '101 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243',
      '102 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4300',
      '103 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243 extra',
      '104 /bin/sh -c /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243',
      '105 /usr/bin/dns-sd -R Other _fremkit._tcp local 4243',
      '',
    ].join('\n'))
    advertise(4243)
    expect(listProcesses).toHaveBeenCalled()
    expect(kill.mock.calls).toEqual([[101]])
    // Cleaned before the new one is started.
    expect(kill.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0])
  })

  it('does nothing off macOS', () => {
    const spawn = vi.fn()
    const listProcesses = vi.fn(() => '')
    const ad = createAdvertiser({ platform: 'linux', spawn, listProcesses })(4243)
    ad.stop()
    expect(spawn).not.toHaveBeenCalled()
    expect(listProcesses).not.toHaveBeenCalled()
  })
})
