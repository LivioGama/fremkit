import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installShutdown, SHUTDOWN_DEADLINE_MS, WATCHDOG_MS } from '../src/shutdown.js'

function setup(close: () => Promise<unknown> = async () => undefined) {
  const order: string[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const handlers = new Map<string, (signal: NodeJS.Signals) => void>()
  const exit = vi.fn((code: number) => { order.push(`exit ${code}`) })
  const watchdog = vi.fn((ms: number) => { order.push(`watchdog ${ms}`) })
  installShutdown({
    close: () => { order.push('close'); return close() },
    closeListenersNow: () => { order.push('listeners') },
    exit,
    watchdog,
    setTimer: (fn, ms) => { timers.push({ fn, ms }) },
    onSignal: (signal, handler) => { handlers.set(signal, handler) },
    log: () => undefined,
  })
  return { order, timers, handlers, exit, watchdog }
}

describe('shutdown', () => {
  it('stops the listeners first, then arms the watchdog and the deadline, then closes the app', async () => {
    const t = setup()
    t.handlers.get('SIGTERM')!('SIGTERM')
    expect(t.order.slice(0, 3)).toEqual(['listeners', `watchdog ${WATCHDOG_MS}`, 'close'])
    expect(t.timers.map((x) => x.ms)).toEqual([SHUTDOWN_DEADLINE_MS])
    await new Promise((resolve) => setImmediate(resolve))
    expect(t.exit).toHaveBeenCalledWith(143)
  })

  it('exits at the deadline when the app never finishes closing, with 130 for SIGINT', () => {
    const t = setup(() => new Promise(() => undefined))
    t.handlers.get('SIGINT')!('SIGINT')
    expect(t.exit).not.toHaveBeenCalled()
    t.timers[0].fn()
    expect(t.exit).toHaveBeenCalledWith(130)
  })

  it('handles the first signal only', () => {
    const t = setup(() => new Promise(() => undefined))
    t.handlers.get('SIGTERM')!('SIGTERM')
    t.handlers.get('SIGINT')!('SIGINT')
    expect(t.order.filter((x) => x === 'listeners')).toHaveLength(1)
  })

  it('a process whose main thread is held after SIGTERM frees its port at once and dies by the watchdog', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'fixtures', 'shutdown-blocked.ts')], {
      cwd: join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const lines: string[] = []
    child.stdout.on('data', (chunk: Buffer) => { lines.push(...chunk.toString().split('\n').filter(Boolean)) })
    const seen = async (ok: () => boolean): Promise<void> => {
      while (!ok()) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await seen(() => lines.length > 0)
    const port = Number(lines[0])
    expect(port).toBeGreaterThan(0)
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
    const sentAt = Date.now()
    child.kill('SIGTERM')
    await seen(() => lines.includes('closed'))
    // Nothing answers on the port any more, though the process is still there.
    const refused = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); resolve(false) })
      socket.once('error', () => resolve(true))
    })
    expect(refused).toBe(true)
    const { signal } = await exited
    expect(signal).toBe('SIGKILL')
    expect(Date.now() - sentAt).toBeLessThan(WATCHDOG_MS + 1_500)
  }, 15_000)
})
