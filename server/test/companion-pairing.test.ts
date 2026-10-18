import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore } from '../src/devices/store.js'
import { CODE_ALPHABET } from '../src/devices/codes.js'
import { CompanionPairing, REQUEST_TTL_MS } from '../src/companion/pairing.js'

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`
const OTHER = `chrome-extension://${'b'.repeat(32)}`
const INSTALL = '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4'

let dir: string
let store: DeviceStore
let clock: number
let pairing: CompanionPairing

const ask = (origin = ORIGIN) => pairing.request({ origin, name: 'Chrome', installId: INSTALL })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-companion-'))
  store = new DeviceStore(join(dir, 'devices.json'))
  await store.load()
  clock = 1_000_000
  pairing = new CompanionPairing(store, () => clock)
})
afterEach(async () => {
  pairing.dispose()
  await rm(dir, { recursive: true, force: true })
})

function accepted(r: ReturnType<typeof ask>) {
  if (r === 'limited') throw new Error('limited')
  return r
}

describe('CompanionPairing', () => {
  it('a new request replaces the pending one', () => {
    const first = accepted(ask())
    const second = accepted(ask())
    expect(second.requestId).not.toBe(first.requestId)
    expect(pairing.pending()).toEqual({ requestId: second.requestId, code: second.code, name: 'Chrome', expiresAt: second.expiresAt })
    expect(pairing.collect(first.requestId, ORIGIN)).toEqual({ state: 'expired' })
    expect(pairing.collect(second.requestId, ORIGIN)).toEqual({ state: 'pending' })
  })

  it('the code is 4 characters of the pairing alphabet', () => {
    for (let i = 0; i < 5; i++) {
      const { code, expiresAt } = accepted(ask())
      expect(code).toHaveLength(4)
      for (const c of code) expect(CODE_ALPHABET).toContain(c)
      expect(expiresAt).toBe(clock + REQUEST_TTL_MS)
      clock += 13_000
    }
  })

  it('a sixth request within a minute is limited', () => {
    for (let i = 0; i < 5; i++) { accepted(ask()); clock += 10_000 }
    expect(ask()).toBe('limited')
    // The window slides: once the first request is a minute old, one more is let in.
    clock = 1_000_000 + 60_000
    expect(ask()).not.toBe('limited')
    expect(ask()).toBe('limited')
  })

  it('approving creates an extension device and collect returns its token once, then expired', async () => {
    const { requestId } = accepted(ask())
    expect(await pairing.approve(requestId)).toBe(true)
    expect(pairing.pending()).toBeNull()
    const got = pairing.collect(requestId, ORIGIN)
    if (got.state !== 'approved') throw new Error(`expected approved, got ${got.state}`)
    expect(store.findByToken(got.token, 'extension')).toMatchObject({ id: got.deviceId, kind: 'extension', origin: ORIGIN, installId: INSTALL, name: 'Chrome' })
    expect(pairing.collect(requestId, ORIGIN)).toEqual({ state: 'expired' })
  })

  it('drops an approved token nobody collected once the request expires', async () => {
    const { requestId } = accepted(ask())
    await pairing.approve(requestId)
    clock += REQUEST_TTL_MS + 1
    expect(pairing.collect(requestId, ORIGIN)).toEqual({ state: 'expired' })
  })

  it('removes the device of an approved request nobody collected once it expires', async () => {
    const { requestId } = accepted(ask())
    await pairing.approve(requestId)
    expect(store.list()).toHaveLength(1)
    clock += REQUEST_TTL_MS + 1
    pairing.pending()
    await vi.waitFor(() => expect(store.list()).toEqual([]))
  })

  it('keeps the device of an approved request that was collected', async () => {
    const { requestId } = accepted(ask())
    await pairing.approve(requestId)
    pairing.collect(requestId, ORIGIN)
    clock += REQUEST_TTL_MS + 1
    pairing.pending()
    await new Promise((r) => setTimeout(r, 20))
    expect(store.list()).toHaveLength(1)
  })

  it('approving an expired request fails and creates no device', async () => {
    const { requestId } = accepted(ask())
    clock += REQUEST_TTL_MS + 1
    expect(pairing.pending()).toBeNull()
    expect(await pairing.approve(requestId)).toBe(false)
    expect(store.list()).toEqual([])
    expect(pairing.collect(requestId, ORIGIN)).toEqual({ state: 'expired' })
  })

  it('collect from another origin is refused', async () => {
    const { requestId } = accepted(ask())
    await pairing.approve(requestId)
    expect(pairing.belongsTo(requestId, OTHER)).toBe(false)
    expect(pairing.collect(requestId, OTHER)).toEqual({ state: 'refused' })
    // The rightful owner still gets its token.
    expect(pairing.collect(requestId, ORIGIN).state).toBe('approved')
  })

  it('refuse makes collect answer refused', () => {
    const { requestId } = accepted(ask())
    expect(pairing.refuse(requestId)).toBe(true)
    expect(pairing.pending()).toBeNull()
    expect(pairing.collect(requestId, ORIGIN)).toEqual({ state: 'refused' })
    expect(pairing.refuse(requestId)).toBe(false)
  })

  it('tells its listeners about every change', async () => {
    let calls = 0
    const off = pairing.onChange(() => { calls++ })
    const a = accepted(ask())
    expect(calls).toBe(1)
    pairing.refuse(a.requestId)
    expect(calls).toBe(2)
    const b = accepted(ask())
    await pairing.approve(b.requestId)
    expect(calls).toBe(4)
    pairing.collect(b.requestId, ORIGIN)
    expect(calls).toBe(5)
    accepted(ask())
    clock += REQUEST_TTL_MS + 1
    expect(pairing.pending()).toBeNull()
    expect(calls).toBe(7)
    off()
    accepted(ask())
    expect(calls).toBe(7)
  })
})
