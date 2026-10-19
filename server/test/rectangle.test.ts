import { describe, expect, it, vi } from 'vitest'
import { createRectangleProvider, nativeArgsFor, nativeInvocationFor } from '../src/providers/rectangle.js'

const nativeTarget = {
  pid: 4242,
  bundleId: 'com.apple.TextEdit',
  title: 'Fremkit Rectangle Probe.txt',
  application: 'TextEdit',
}

describe('built-in macOS window provider', () => {
  it('inspects the active app and returns an opaque target token without exposing its title', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => args[1] === 'inspect'
      ? JSON.stringify({ ok: true, target: nativeTarget })
      : JSON.stringify({ ok: true }))
    const provider = createRectangleProvider(run)

    const result = await provider.commands?.['inspect-target']?.({}, { loopback: true }) as {
      ok: boolean
      target?: { token: string; application: string }
    }

    expect(result.ok).toBe(true)
    expect(result.target?.application).toBe('TextEdit')
    expect(result.target?.token).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(result)).not.toContain(nativeTarget.title)
    expect(run).toHaveBeenCalledWith('/usr/bin/swift', nativeArgsFor('inspect'))
  })

  it.each(['left-half', 'right-half', 'fill', 'next-display'] as const)(
    'runs the built-in native action %s only for the inspected target', async (action) => {
      const run = vi.fn(async (_file: string, args: string[]) => args[1] === 'inspect'
        ? JSON.stringify({ ok: true, target: nativeTarget })
        : JSON.stringify({ ok: true, changed: true }))
      const provider = createRectangleProvider(run)
      const inspected = await provider.commands?.['inspect-target']?.({}, { loopback: true }) as {
        target: { token: string }
      }

      const result = await provider.commands?.run?.({ action, targetToken: inspected.target.token }, { loopback: true })

      expect(result).toEqual({ ok: true, changed: true })
      expect(run).toHaveBeenLastCalledWith('/usr/bin/swift', nativeArgsFor(action, nativeTarget))
      expect(run.mock.calls.flatMap(([, args]) => args).join(' ')).not.toContain('rectangle://')
    },
  )

  it.each([
    ['left-half', ['menu', 'Window', 'Move & Resize', 'Left']],
    ['right-half', ['menu', 'Window', 'Move & Resize', 'Right']],
    ['fill', ['menu', 'Window', 'Fill']],
    ['next-display', ['position', 'next-display']],
  ] as const)('maps %s to a built-in macOS action', (action, invocation) => {
    expect(nativeInvocationFor(action)).toEqual(invocation)
    expect(nativeArgsFor(action, nativeTarget).slice(5)).toEqual(invocation)
  })

  it('rejects remote, malformed, stale, and arbitrary-target requests without invoking a native action', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => JSON.stringify({ ok: true, target: nativeTarget }))
    const provider = createRectangleProvider(run)

    await expect(provider.commands?.['inspect-target']?.({}, { loopback: false }))
      .resolves.toEqual({ ok: false, error: 'local-only' })
    await expect(provider.commands?.run?.({ action: 'run-shell', targetToken: 'nope' }, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'invalid-request' })
    await expect(provider.commands?.run?.({ action: 'left-half', targetToken: '00000000-0000-4000-8000-000000000001' }, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'target-expired' })
    expect(run).not.toHaveBeenCalled()
  })

  it('fails closed when the inspected foreground window is not a safe app window', async () => {
    const run = vi.fn(async () => JSON.stringify({ ok: false, error: 'unsafe-target' }))
    const provider = createRectangleProvider(run)

    await expect(provider.commands?.['inspect-target']?.({}, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'no-target' })
  })

  it('fails closed when native geometry verification does not succeed', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => args[1] === 'inspect'
      ? JSON.stringify({ ok: true, target: nativeTarget })
      : JSON.stringify({ ok: false, error: 'geometry-unverified' }))
    const provider = createRectangleProvider(run)
    const inspected = await provider.commands?.['inspect-target']?.({}, { loopback: true }) as {
      target: { token: string }
    }

    await expect(provider.commands?.run?.({ action: 'left-half', targetToken: inspected.target.token }, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'geometry-unverified' })
  })
})
