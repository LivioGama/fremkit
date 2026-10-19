import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore } from '../src/devices/store.js'
import { CODE_ALPHABET } from '../src/devices/codes.js'
import { CompanionPairing, MAX_CONFIRMATIONS, MAX_TURNED_AWAY, REFUSED_COOLDOWN_MS, REQUEST_TTL_MS } from '../src/companion/pairing.js'
import { PAIR_CLIENT_LABEL, PAIR_KEY_ITERATIONS, PAIR_SERVER_LABEL, pairKey, pairMac } from '../src/companion/pairProof.js'

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
const refuse = (r: { requestId: string; code: string }) => pairing.refuse(r.requestId, r.code)

const NONCE_E = Buffer.alloc(32, 7).toString('base64url')

/**
 * What the extension does with `typed`: confirm, check the server's mac against the code, and
 * finish with its own (or give up, when the server's does not match). The finish's answer.
 */
async function typeCode(r: { requestId: string; code: string }, typed = r.code, origin = ORIGIN) {
  const c = await pairing.confirm(r.requestId, origin, NONCE_E)
  if (c.state !== 'confirm') return c
  const key = await pairKey(typed, r.requestId)
  if (c.mac !== pairMac(key, PAIR_SERVER_LABEL, r.requestId, NONCE_E, c.nonce)) return pairing.finish(r.requestId, origin, null)
  return pairing.finish(r.requestId, origin, pairMac(key, PAIR_CLIENT_LABEL, r.requestId, NONCE_E, c.nonce))
}
const otherCode = (code: string) => (code === 'ZZZZ' ? 'YYYY' : 'ZZZZ')

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
    expect((await typeCode(second)).state).toBe('paired')
    clock += REQUEST_TTL_MS
    accepted(ask(ORIGIN, fresh()))
    expect(pairing.pending()?.turnedAway).toBe(0)
  })

  it('forgets the turned-away count once no request has waited for a request\'s life', () => {
    const squatter = accepted(ask())
    expect(ask(ORIGIN, INSTALL_2)).toBe('busy')
    expect(pairing.pending()).toMatchObject({ requestId: squatter.requestId, turnedAway: 1 })
    // The request expires unanswered; just short of a whole TTL later, a new one still carries it.
    clock += REQUEST_TTL_MS
    expect(pairing.pending()).toBeNull()
    clock += REQUEST_TTL_MS - 1
    const soon = accepted(ask(ORIGIN, fresh()))
    expect(pairing.pending()).toMatchObject({ requestId: soon.requestId, turnedAway: 1 })
    // That one expires too, and nothing asks for a whole TTL: the next request starts from zero.
    clock += REQUEST_TTL_MS
    expect(pairing.pending()).toBeNull()
    clock += REQUEST_TTL_MS
    const later = accepted(ask(ORIGIN, fresh()))
    expect(pairing.pending()).toMatchObject({ requestId: later.requestId, turnedAway: 0 })
  })

  it('a new request from the same install replaces its own waiting one', () => {
    const first = accepted(ask())
    const second = accepted(ask())
    expect(second.requestId).not.toBe(first.requestId)
    expect(pairing.pending()).toEqual({ requestId: second.requestId, code: second.code, name: 'Chrome', extension: 'aaaaaa', expiresAt: second.expiresAt, turnedAway: 0 })
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
    expect((await typeCode(first)).state).toBe('paired')
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

  it('refuse needs the code on show', () => {
    const r = accepted(ask())
    expect(pairing.refuse(r.requestId, otherCode(r.code))).toBe('changed')
    expect(pairing.refuse(r.requestId, undefined)).toBe('changed')
    expect(pairing.refuse(r.requestId, '')).toBe('changed')
    expect(pairing.pending()?.requestId).toBe(r.requestId)
    expect(refuse(r)).toBe('ok')
  })

  it('a refusal given for a request that was replaced is a changed request', () => {
    const old = accepted(ask())
    const now = accepted(ask())
    expect(refuse(old)).toBe('changed')
    // The new id with the old code is no better: the user read the old one.
    expect(pairing.refuse(now.requestId, old.code === now.code ? otherCode(now.code) : old.code)).toBe('changed')
    expect(refuse(now)).toBe('ok')
  })

  it('a refusal with nothing waiting is not found', () => {
    const r = accepted(ask())
    expect(refuse(r)).toBe('ok')
    expect(refuse(r)).toBe('notFound')
  })

  it('typing the code pairs the extension and hands its token out once', async () => {
    const r = accepted(ask())
    const got = await typeCode(r)
    if (got.state !== 'paired') throw new Error(`expected paired, got ${got.state}`)
    expect(store.findByToken(got.token, 'extension')).toMatchObject({ id: got.deviceId, kind: 'extension', origin: ORIGIN, installId: INSTALL, name: 'Chrome' })
    expect(pairing.pending()).toBeNull()
    expect(pairing.collect(r.requestId, ORIGIN)).toEqual({ state: 'expired' })
    expect(await typeCode(r)).toEqual({ state: 'expired' })
    expect(store.list()).toHaveLength(1)
  })

  it('the server proves the code first: its mac matches the code only', async () => {
    const r = accepted(ask())
    const c = await pairing.confirm(r.requestId, ORIGIN, NONCE_E)
    if (c.state !== 'confirm') throw new Error(c.state)
    expect(c.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(c.nonce).not.toBe(NONCE_E)
    expect(c.mac).toBe(pairMac(await pairKey(r.code, r.requestId), PAIR_SERVER_LABEL, r.requestId, NONCE_E, c.nonce))
    expect(c.mac).not.toBe(pairMac(await pairKey(otherCode(r.code), r.requestId), PAIR_SERVER_LABEL, r.requestId, NONCE_E, c.nonce))
    // A fresh nonce each time.
    const again = await pairing.confirm(r.requestId, ORIGIN, NONCE_E)
    expect(again.state === 'confirm' && again.nonce).not.toBe(c.nonce)
  })

  it('a wrong code pairs nothing, and the third try refuses the request', async () => {
    const r = accepted(ask())
    expect(await typeCode(r, otherCode(r.code))).toEqual({ state: 'wrong' })
    expect(await typeCode(r, otherCode(r.code))).toEqual({ state: 'wrong' })
    expect(store.list()).toEqual([])
    expect(pairing.pending()?.requestId).toBe(r.requestId)
    expect(await typeCode(r, otherCode(r.code))).toEqual({ state: 'refused' })
    expect(pairing.pending()).toBeNull()
    expect(pairing.collect(r.requestId, ORIGIN)).toEqual({ state: 'refused' })
    // Even the right code is too late now, and the install waits like after a refusal.
    expect(await typeCode(r)).toEqual({ state: 'refused' })
    expect(store.list()).toEqual([])
    expect(ask()).toBe('cooldown')
  })

  it('a wrong mac from the extension counts like a wrong code', async () => {
    const r = accepted(ask())
    for (let i = 1; i <= MAX_CONFIRMATIONS; i++) {
      const c = await pairing.confirm(r.requestId, ORIGIN, NONCE_E)
      expect(c.state).toBe('confirm')
      expect((await pairing.finish(r.requestId, ORIGIN, 'A'.repeat(43))).state).toBe(i < MAX_CONFIRMATIONS ? 'wrong' : 'refused')
    }
    expect(store.list()).toEqual([])
  })

  it('a request gets three confirmations, finished or not', async () => {
    const r = accepted(ask())
    for (let i = 0; i < MAX_CONFIRMATIONS; i++) expect((await pairing.confirm(r.requestId, ORIGIN, NONCE_E)).state).toBe('confirm')
    expect(await pairing.confirm(r.requestId, ORIGIN, NONCE_E)).toEqual({ state: 'refused' })
    expect(pairing.pending()).toBeNull()
  })

  it('one confirmation is live at a time: a new one replaces it, and a finish answers it once', async () => {
    const r = accepted(ask())
    const key = await pairKey(r.code, r.requestId)
    const first = await pairing.confirm(r.requestId, ORIGIN, NONCE_E)
    const second = await pairing.confirm(r.requestId, ORIGIN, NONCE_E)
    if (first.state !== 'confirm' || second.state !== 'confirm') throw new Error('no confirmation')
    // The first one's mac answers a confirmation that is no longer live.
    expect(await pairing.finish(r.requestId, ORIGIN, pairMac(key, PAIR_CLIENT_LABEL, r.requestId, NONCE_E, first.nonce))).toEqual({ state: 'wrong' })
    // That finish used the live one up: the right mac for it now finds none.
    expect(await pairing.finish(r.requestId, ORIGIN, pairMac(key, PAIR_CLIENT_LABEL, r.requestId, NONCE_E, second.nonce))).toEqual({ state: 'noConfirm' })
    expect(store.list()).toEqual([])
  })

  it('a finish with no confirmation is noConfirm and counts nothing', async () => {
    const r = accepted(ask())
    for (let i = 0; i < 5; i++) expect(await pairing.finish(r.requestId, ORIGIN, 'A'.repeat(43))).toEqual({ state: 'noConfirm' })
    expect((await typeCode(r)).state).toBe('paired')
  })

  it('two finishes racing on one confirmation pair once', async () => {
    const r = accepted(ask())
    const c = await pairing.confirm(r.requestId, ORIGIN, NONCE_E)
    if (c.state !== 'confirm') throw new Error(c.state)
    const mac = pairMac(await pairKey(r.code, r.requestId), PAIR_CLIENT_LABEL, r.requestId, NONCE_E, c.nonce)
    const results = await Promise.all([pairing.finish(r.requestId, ORIGIN, mac), pairing.finish(r.requestId, ORIGIN, mac)])
    expect(results.map((x) => x.state).sort()).toEqual(['noConfirm', 'paired'])
    expect(store.list()).toHaveLength(1)
  })

  it('a refusal on the Edge ends a confirmation in flight', async () => {
    const r = accepted(ask())
    const c = await pairing.confirm(r.requestId, ORIGIN, NONCE_E)
    if (c.state !== 'confirm') throw new Error(c.state)
    expect(refuse(r)).toBe('ok')
    const mac = pairMac(await pairKey(r.code, r.requestId), PAIR_CLIENT_LABEL, r.requestId, NONCE_E, c.nonce)
    expect(await pairing.finish(r.requestId, ORIGIN, mac)).toEqual({ state: 'refused' })
    expect(store.list()).toEqual([])
  })

  it('an expired request confirms nothing and creates no device', async () => {
    const r = accepted(ask())
    clock += REQUEST_TTL_MS + 1
    expect(pairing.pending()).toBeNull()
    expect(await typeCode(r)).toEqual({ state: 'expired' })
    expect(store.list()).toEqual([])
    expect(pairing.collect(r.requestId, ORIGIN)).toEqual({ state: 'expired' })
  })

  it('another origin can neither confirm, finish nor collect, and leaves the request as it was', async () => {
    const r = accepted(ask())
    expect(pairing.belongsTo(r.requestId, OTHER)).toBe(false)
    expect(await pairing.confirm(r.requestId, OTHER, NONCE_E)).toEqual({ state: 'refused' })
    expect(await pairing.finish(r.requestId, OTHER, null)).toEqual({ state: 'refused' })
    expect(pairing.collect(r.requestId, OTHER)).toEqual({ state: 'refused' })
    // The rightful owner still pairs, with all its tries.
    expect((await typeCode(r)).state).toBe('paired')
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
    expect(calls).toBe(3)
    await typeCode(b)
    expect(calls).toBe(4)
    accepted(ask(ORIGIN, INSTALL_2))
    clock += REQUEST_TTL_MS + 1
    expect(pairing.pending()).toBeNull()
    expect(calls).toBe(6)
    off()
    accepted(ask(ORIGIN, INSTALL_2))
    expect(calls).toBe(6)
  })
})

/**
 * K(code) and both macs for fixed inputs. The same vector is in companion-extension-lib.test.ts,
 * run through companion/lib/pairProof.js: keep the two in step.
 */
describe('the typed-code proof vector', () => {
  const requestId = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
  const nonceE = Buffer.alloc(32, 1).toString('base64url')
  const nonceS = Buffer.alloc(32, 2).toString('base64url')

  it('pins K(code) and the server and client macs', async () => {
    expect(PAIR_KEY_ITERATIONS).toBe(600_000)
    const key = await pairKey('K7QM', requestId)
    expect(key.toString('hex')).toBe('a4cf5dbd6f76bcf8117a2098cfdd2aa40310b26b00d984e897968c829796b0b8')
    expect(pairMac(key, PAIR_SERVER_LABEL, requestId, nonceE, nonceS)).toBe('zmpz29L7bwyvBl7bCYR3wAVbWK86PKl4QGHYHj3cvak')
    expect(pairMac(key, PAIR_CLIENT_LABEL, requestId, nonceE, nonceS)).toBe('m0kTJZhVO_hpRSFRV_B8N1lgNrozNintFWLnhPq00Jw')
  })
})
