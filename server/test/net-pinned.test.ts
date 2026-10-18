import { describe, it, expect } from 'vitest'
import type { LookupAddress } from 'node:dns'
import { guardedLookup, PrivateAddressError } from '../src/net/pinned.js'

/** A resolver that answers `addresses`, for every name. */
const answering = (addresses: LookupAddress[]) =>
  (_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) => cb(null, addresses)

function run(addresses: LookupAddress[], all: boolean): Promise<{ err: Error | null; result: unknown }> {
  return new Promise((resolve) => {
    guardedLookup(answering(addresses))('rebind.example', { all } as never, (err, result) => resolve({ err, result }))
  })
}

describe('guardedLookup', () => {
  it('hands back what it checked when every address is public', async () => {
    const one = await run([{ address: '198.51.100.7', family: 4 }], false)
    expect(one.err).toBeNull()
    expect(one.result).toBe('198.51.100.7')
    const all = await run([{ address: '198.51.100.7', family: 4 }, { address: '2001:db8::1', family: 6 }], true)
    expect(all.err).toBeNull()
    expect(all.result).toHaveLength(2)
  })
  it('refuses the lot when any address is private, in any spelling', async () => {
    for (const address of ['127.0.0.1', '192.0.2.1', '10.0.0.1', '::1', 'fe80::1', '::ffff:7f00:1', '169.254.169.254']) {
      const { err } = await run([{ address: '198.51.100.7', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }], true)
      expect(err, address).toBeInstanceOf(PrivateAddressError)
    }
  })
  it('refuses a name with no address at all', async () => {
    expect((await run([], false)).err).toBeInstanceOf(PrivateAddressError)
  })
})
