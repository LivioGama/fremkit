/**
 * Pairing the browser extension. Two audiences, never mixed:
 *
 * - the extension: `POST /api/companion/pair` and `GET /api/companion/pair/:requestId`. They answer
 *   without the access secret (see `isCompanionRoute`), so each one checks the extension origin
 *   itself; a web page cannot send a `chrome-extension://` origin.
 * - the Edge and the admin, on this Mac: approve and refuse, behind the access secret like
 *   everything else.
 *
 * None of them is on the remote listener's allow-list, so a paired iPad gets 404; each also
 * refuses a remote request itself, in case the allow-list ever grows by mistake.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ConfigStore } from '../config/store.js'
import { tr, type MessageKey } from '../i18n.js'
import { isRemoteRequest } from '../net/remote.js'
import type { CompanionPairing } from './pairing.js'
import { EXTENSION_ORIGIN_RE } from './protocol.js'

export interface CompanionRoutesOptions {
  pairing: CompanionPairing
  config: Pick<ConfigStore, 'get'>
}

const PairSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  installId: z.uuid(),
})

const RequestIdSchema = z.uuid()

type Params = { Params: { requestId: string } }

/** The request's extension origin, or null when it has none (or several). */
function extensionOrigin(req: FastifyRequest): string | null {
  const origin = req.headers.origin
  return typeof origin === 'string' && EXTENSION_ORIGIN_RE.test(origin) ? origin : null
}

export async function companionRoutes(app: FastifyInstance, opts: CompanionRoutesOptions): Promise<void> {
  const { pairing } = opts
  const locale = () => opts.config.get().locale
  const fail = (reply: FastifyReply, status: number, key: MessageKey): FastifyReply =>
    reply.code(status).header('cache-control', 'no-store').send({ error: tr(locale(), key) })

  /** Every route here is this Mac's only. */
  const localOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (isRemoteRequest(req)) return reply.callNotFound()
  }

  // --- the extension ----------------------------------------------------------------------------

  app.post('/api/companion/pair', { onRequest: localOnly }, async (req, reply) => {
    const origin = extensionOrigin(req)
    if (origin === null) return fail(reply, 403, 'companion.originNotAllowed')
    const parsed = PairSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
    }
    const result = pairing.request({ origin, ...parsed.data })
    if (result === 'limited') {
      req.log.warn({ origin }, 'companion pairing request refused: too many')
      return fail(reply, 429, 'companion.limited')
    }
    // Never the code. The id is no secret on its own: collecting also needs the request's origin.
    req.log.info({ origin }, 'companion pairing requested')
    reply.header('cache-control', 'no-store')
    return result
  })

  app.get<Params>('/api/companion/pair/:requestId', { onRequest: localOnly }, async (req, reply) => {
    const origin = extensionOrigin(req)
    if (origin === null) return fail(reply, 403, 'companion.originNotAllowed')
    reply.header('cache-control', 'no-store')
    const id = RequestIdSchema.safeParse(req.params.requestId)
    if (!id.success) return { state: 'expired' }
    if (!pairing.belongsTo(id.data, origin)) return fail(reply, 403, 'companion.originNotAllowed')
    const result = pairing.collect(id.data, origin)
    if (result.state === 'approved') req.log.info({ origin, deviceId: result.deviceId }, 'companion token collected')
    return result
  })

  // --- the Edge and the admin -------------------------------------------------------------------

  app.post<Params>('/api/companion/requests/:requestId/approve', { onRequest: localOnly }, async (req, reply) => {
    if (!(await pairing.approve(req.params.requestId))) return fail(reply, 404, 'companion.requestNotFound')
    req.log.info('companion pairing approved')
    return { ok: true }
  })

  app.post<Params>('/api/companion/requests/:requestId/refuse', { onRequest: localOnly }, async (req, reply) => {
    if (!pairing.refuse(req.params.requestId)) return fail(reply, 404, 'companion.requestNotFound')
    req.log.info('companion pairing refused')
    return { ok: true }
  })
}
