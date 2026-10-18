/**
 * Fetching a host that must be public, with the check made on the address actually connected to.
 *
 * `resolvesToPrivate` judges a name by looking it up; `fetch` then looks it up *again* to
 * connect. A name with a zero TTL can answer a public address to the first lookup and
 * `127.0.0.1` or a LAN address to the second (DNS rebinding), and the request lands on a service
 * the check refused. Here the connection's own lookup does the judging: the socket is opened on
 * an address that has just been checked, or not at all. A literal address is never looked up,
 * so callers still judge literals themselves (`resolvesToPrivate` does).
 *
 * Used by the widget proxy's `GET /api/proxy/:widgetId` and the favicon fetches — the requests
 * that go to hosts a widget or a page named. Declared connections reach the LAN on purpose and
 * do not use it; the registry pins its own host.
 */

import { lookup as dnsLookup } from 'node:dns'
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns'
import { Agent, fetch as undiciFetch } from 'undici'
import { isPrivateAddress } from './private.js'

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
type Resolver = (host: string, options: LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void

/** The error a refused address surfaces as; fetch reports it as a failed request. */
export class PrivateAddressError extends Error {
  readonly code = 'EFREMKITPRIVATE'
  constructor() {
    super('refused: the name resolves to a private or local address')
  }
}

/**
 * A `lookup` for `net.connect` that resolves every address of the name and refuses the lot if
 * any is private — the same rule as `resolvesToPrivate` — then hands back what it checked.
 */
export function guardedLookup(resolve: Resolver = dnsLookup as unknown as Resolver) {
  return (host: string, options: LookupOneOptions | LookupAllOptions | undefined, callback: LookupCallback): void => {
    const opts = (options ?? {}) as { all?: boolean; family?: number; hints?: number }
    resolve(host, { family: opts.family, hints: opts.hints, all: true, verbatim: true } as LookupAllOptions, (err, addresses) => {
      if (err) return callback(err, opts.all ? [] : '', undefined)
      if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
        return callback(new PrivateAddressError() as NodeJS.ErrnoException, opts.all ? [] : '', undefined)
      }
      if (opts.all) return callback(null, addresses)
      callback(null, addresses[0].address, addresses[0].family)
    })
  }
}

/** One dispatcher for the whole process: its connections are pooled like the global fetch's. */
let shared: Agent | undefined
export function publicDispatcher(): Agent {
  shared ??= new Agent({ connect: { lookup: guardedLookup() } })
  return shared
}

/** The shape of `fetch` the callers use. */
export type PublicFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/** `fetch`, through `publicDispatcher`: a name that resolves to a private address is never connected to. */
export const publicFetch: PublicFetch = (input, init) =>
  undiciFetch(input, { ...(init as object), dispatcher: publicDispatcher() }) as unknown as Promise<Response>
