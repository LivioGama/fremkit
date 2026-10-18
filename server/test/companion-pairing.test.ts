import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore } from '../src/devices/store.js'
import { CODE_ALPHABET } from '../src/devices/codes.js'
import { CompanionPairing, MAX_TURNED_AWAY, REFUSED_COOLDOWN_MS, REQUEST_TTL_MS } from '../src/companion/pairing.js'

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`
const OTHER = `chrome-extension://${'b'.repeat(32)}`
const INSTALL = '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4'
const INSTALL_2 = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

let dir: string
let store: DeviceStore
let clock: number
let pairing: CompanionPairing

const ask = (origin = ORIGIN, installId = INSTALL) => pairing.request({ origin, name: 'Chrome', installId })
/** A fresh install each time, for tests about the global count rather than one install's. */
let installs = 0
const fresh = () => `6f1c2b8e-3d4a-4b5c-9d6e-${String(++installs).padStart(12, '0')}`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-companion-'))
  store = new DeviceStore(join(dir, 'devices.json'))
  await store.load()
  clock = 1_000_000
  pairing = new CompanionPairing(store, () => clock)
})
afterEach(async () => {
  pairing.dispose()
  await store.settled()
  await rm(dir, { recursive: true, force: true })
})

function accepted(r: ReturnType<typeof ask>) {
  if (typeof r === 'string') throw new Error(r)
  return r
}
/** Answers with the code the request showed, as the Edge does. */
const approve = (r: { requestId: string; code: string }) => pairing.approve(r.requestId, r.code)
const refuse = (r: { requestId: string; code: string }) => pairing.refuse(r.requestId, r.code)

describe('CompanionPairing', () => {
  it('counts the distinct installs turned away while a request waits, for the Edge to show', () => {
    const squatter = accepted(ask())
    expect(pairing.pending()?.turnedAway).toBe(0)
    let changes = 0
    pairing.onChange(() => { changes++ })
    expect(ask(ORIGIN, INSTALL_2)).toBe('busy')
    expect(ask(ORIGIN, INSTALL_2)).toBe('busy')
    expect(ask(OTHER, INSTALL_2)).toBe('busy')
    expect(pairing.pending()).toMatchObject({ requestId: squatter.requestId, turnedAway: 2 })
    // Only a new install is news.
    expect(changes).toBe(2)
    // Bounded, however many install ids a program makes up.
    for (let i = 0; i < 300; i++) ask(ORIGIN, fresh())
    expect(pairing.pending()?.turnedAway).toBe(MAX_TURNED_AWAY)
    // Neither the squatter replacing its own request nor a new one after an expiry clears it.
    accepted(ask())
    expect(pairing.pending()?.turnedAway).toBe(MAX_TURNED_AWAY)
    clock += REQUEST_TTL_MS
    accepted(ask(ORIGIN, INSTALL_2))
    expect(pairing.pending()?.turnedAway).toBe(MAX_TURNED_AWAY)
  })

  it('clears the turned-away count only when the user answers', async () => {
    const first = accepted(ask())
    expect(ask(ORIGIN, INSTALL_2)).toBe('busy')
    expect(refuse(first)).toBe('ok')
    const second = accepted(ask(ORIGIN, INSTALL_2))
    expect(pairing.pending()?.turnedAway).toBe(0)
    expect(ask(ORIGIN, fresh())).toBe('busy')
    expect(pairing.pending()?.turnedAway).toBe(1)
    expect(await approve(second)).toBe('ok')
    clock += REQUEST_TTL_MS
    accepted(ask(ORIGIN, fresh()))
    expect(pairing.pending()?.turnedAway).toBe(0)
  })

  it('a new request from the same install replaces its own waiting one', () => {
    const first = accepted(ask())
    const second = accepted(ask())
    expect(second.requestId).not.toBe(first.requestId)
    expect(pairing.pending()).toEqual({ requestId: second.requestId, code: second.code, name: 'Chrome', expiresAt: second.expiresAt, turnedAway: 0 })
    expect(pairing.collect(first.requestId, ORIGIN)).toEqual({ state: 'expired' })
    expect(pairing.collect(second.requestId, ORIGIN)).toEqual({ state: 'pending' })
  })

  it('the code is 4 characters of the pairing alphabet', () => {
    for (let i = 0; i < 5; i++) {
      const { code, expiresAt } = accepted(ask())
      expect(code).toHaveLength(4)
      for (const c of code) expect(CODE_ALPHABET).toContain(c)
      expect(expiresAt).toBe(clock + REQUEST_TTL_MS)
      clock += 21_000
    }
  })

  it('a sixth request within a minute is limited', () => {
    // Each one answered, so the next install is not turned away as busy.
    const next = () => { const r = ask(ORIGIN, fresh()); if (typeof r !== 'string') pairing.refuse(r.requestId, r.code); return r }
    for (let i = 0; i < 5; i++) { accepted(next()); clock += 10_000 }
    expect(next()).toBe('limited')
    // The window slides: once the first request is a minute old, one more is let in.
    clock = 1_000_000 + 60_000
    expect(next()).not.toBe('limited')
    expect(next()).toBe('limited')
  })

  it('another install is turned away while a request waits, and let in once it is answered or gone', async () => {
    const first = accepted(ask())
    expect(ask(ORIGIN, INSTALL_2)).toBe('busy')
    // Another origin with the same install id is not the same extension either.
    expect(ask(OTHER, INSTALL)).toBe('busy')
    expect(pairing.pending()?.requestId).toBe(first.requestId)
    expect(await approve(first)).toBe('ok')
    accepted(ask(ORIGIN, INSTALL_2))
    clock += REQUEST_TTL_MS + 1
    accepted(ask(OTHER, fresh()))
  })

  it('a busy answer does not count against the limits', () => {
    accepted(ask())
    for (let i = 0; i < 10; i++) expect(ask(ORIGIN, INSTALL_2)).toBe('busy')
    accepted(ask())
  })

  it('one install gets three requests a minute', () => {
    for (let i = 0; i < 3; i++) { accepted(ask()); clock += 1_000 }
    expect(ask()).toBe('limited')
    clock = 1_000_000 + 60_000
    accepted(ask())
  })

  it('an install whose request was refused is turned away for a minute', () => {
    const r = accepted(ask())
    expect(refuse(r)).toBe('ok')
    clock += REFUSED_COOLDOWN_MS - 1
    expect(ask()).toBe('cooldown')
    // Another install is not held back by it.
    expect(typeof ask(ORIGIN, INSTALL_2)).toBe('object')
    refuse(pairing.pending()!)
    clock += 1
    accepted(ask())
  })

  it('approve and refuse need the code on show', async () => {
    const r = accepted(ask())
    expect(await pairing.approve(r.requestId, 'ZZZZ' === r.code ? 'YYYY' : 'ZZZZ')).toBe('changed')
    expect(await pairing.approve(r.requestId, undefined)).toBe('changed')
    expect(pairing.refuse(r.requestId, '')).toBe('changed')
    expect(store.list()).toEqual([])
    expect(pairing.pending()?.requestId).toBe(r.requestId)
    expect(await approve(r)).toBe('ok')
  })

  it('an answer given for a request that was replaced is a changed request', async () => {
    const old = accepted(ask())
    const now = accepted(ask())
    expect(await approve(old)).toBe('changed')
    // The new id with the old code is no better: the user read the old one.
    expect(await pairing.approve(now.requestId, old.code === now.code ? 'ZZZZ' : old.code)).toBe('changed')
    expect(refuse(old)).toBe('changed')
    expect(store.list()).toEqual([])
    expect(await approve(now)).toBe('ok')
  })

  it('an answer with nothing waiting is not found', async () => {
    const r = accepted(ask())
    expect(refuse(r)).toBe('ok')
    expect(await approve(r)).toBe('notFound')
    expect(refuse(r)).toBe('notFound')
  })

  it('approving creates an extension device and collect returns its token once, then expired', async () => {
    const r = accepted(ask())
    const { requestId } = r
    expect(await approve(r)).toBe('ok')
    expect(pairing.pending()).toBeNull()
    const got = pairing.collect(requestId, ORIGIN)
    if (got.state !== 'approved') throw new Error(`expected approved, got ${got.state}`)
    expect(store.findByToken(got.token, 'extension')).toMatchObject({ id: got.deviceId, kind: 'extension', origin: ORIGIN, installId: INSTALL, name: 'Chrome' })
    expect(pairing.collect(requestId, ORIGIN)).toEqual({ state: 'expired' })
  })

  it('drops an approved token nobody collected once the request expires', async () => {
    const r = accepted(ask())
    const { requestId } = r
    await approve(r)
    clock += REQUEST_TTL_MS + 1
    expect(pairing.collect(requestId, ORIGIN)).toEqual({ state: 'expired' })
  })

  it('removes the device of an approved request nobody collected once it expires', async () => {
    const r = accepted(ask())
    const { requestId } = r
    await approve(r)
    expect(store.list()).toHaveLength(1)
    clock += REQUEST_TTL_MS + 1
    pairing.pending()
    await vi.waitFor(() => expect(store.list()).toEqual([]))
  })

  it('keeps the device of an approved request that was collected', async () => {
    const r = accepted(ask())
    const { requestId } = r
    await approve(r)
    pairing.collect(requestId, ORIGIN)
    clock += REQUEST_TTL_MS + 1
    pairing.pending()
    await new Promise((r) => setTimeout(r, 20))
    expect(store.list()).toHaveLength(1)
  })

  it('approving an expired request fails and creates no device', async () => {
    const r = accepted(ask())
    const { requestId } = r
    clock += REQUEST_TTL_MS + 1
    expect(pairing.pending()).toBeNull()
    expect(await approve(r)).toBe('notFound')
    expect(store.list()).toEqual([])
    expect(pairing.collect(requestId, ORIGIN)).toEqual({ state: 'expired' })
  })

  it('collect from another origin is refused', async () => {
    const r = accepted(ask())
    const { requestId } = r
    await approve(r)
    expect(pairing.belongsTo(requestId, OTHER)).toBe(false)
    expect(pairing.collect(requestId, OTHER)).toEqual({ state: 'refused' })
    // The rightful owner still gets its token.
    expect(pairing.collect(requestId, ORIGIN).state).toBe('approved')
  })

  it('refuse makes collect answer refused', () => {
    const r = accepted(ask())
    const { requestId } = r
    expect(refuse(r)).toBe('ok')
    expect(pairing.pending()).toBeNull()
    expect(pairing.collect(requestId, ORIGIN)).toEqual({ state: 'refused' })
    expect(refuse(r)).toBe('notFound')
  })

  it('tells its listeners about every change', async () => {
    let calls = 0
    const off = pairing.onChange(() => { calls++ })
    const a = accepted(ask())
    expect(calls).toBe(1)
    refuse(a)
    expect(calls).toBe(2)
    const b = accepted(ask(ORIGIN, INSTALL_2))
    await approve(b)
    expect(calls).toBe(4)
    pairing.collect(b.requestId, ORIGIN)
    expect(calls).toBe(5)
    accepted(ask(ORIGIN, INSTALL_2))
    clock += REQUEST_TTL_MS + 1
    expect(pairing.pending()).toBeNull()
    expect(calls).toBe(7)
    off()
    accepted(ask(ORIGIN, INSTALL_2))
    expect(calls).toBe(7)
  })
})
