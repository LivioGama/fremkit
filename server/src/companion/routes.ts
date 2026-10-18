/**
 * Pairing the browser extension. Two audiences, never mixed:
 *
 * - the extension: `POST /api/companion/pair` and `POST /api/companion/pair/:requestId`. They answer
 *   without the access secret (see `isCompanionRoute`), so each one checks the extension origin
 *   itself; a web page cannot send a `chrome-extension://` origin. Collecting is a POST, not a GET:
 *   Chrome leaves `Origin` off an extension's GET to a host it has a permission for.
 * - the Edge and the admin, on this Mac: approve and refuse, behind the access secret like
 *   everything else. Each carries the code it showed, so an answer never lands on a request that
 *   took the shown one's place.
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

/**
 * The names the extension may give itself (`companion/lib/browser.js`). A closed list: the name is
 * shown on the Edge next to the code, and a free one could read "Approve this, it is safe".
 */
export const COMPANION_NAMES = ['Chrome', 'Edge', 'Brave', 'Arc', 'Opera', 'Vivaldi', 'Chromium'] as const

const PairSchema = z.strictObject({
  name: z.enum(COMPANION_NAMES),
  installId: z.uuid(),
})

/** The code the Edge or the admin showed when the user answered. */
const AnswerSchema = z.object({ code: z.string().max(16) })

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
  const fail = (reply: FastifyReply, status: number, key: MessageKey, reason?: string): FastifyReply =>
    reply.code(status).header('cache-control', 'no-store').send({ error: tr(locale(), key), ...(reason ? { reason } : {}) })

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
    // `reason` tells the extension which of its own messages to show; `error` is for a person.
    if (result === 'limited') {
      req.log.warn({ origin }, 'companion pairing request refused: too many')
      return fail(reply, 429, 'companion.limited', 'limited')
    }
    if (result === 'cooldown') {
      req.log.warn({ origin }, 'companion pairing request refused: refused a moment ago')
      return fail(reply, 429, 'companion.pairCooldown', 'cooldown')
    }
    if (result === 'busy') {
      req.log.warn({ origin }, 'companion pairing request refused: another one is waiting')
      return fail(reply, 409, 'companion.pairBusy', 'busy')
    }
    // Never the code. The id is no secret on its own: collecting also needs the request's origin.
    req.log.info({ origin }, 'companion pairing requested')
    reply.header('cache-control', 'no-store')
    return result
  })

  app.post<Params>('/api/companion/pair/:requestId', { onRequest: localOnly }, async (req, reply) => {
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

  /** `{ code }` is the code on show when the user tapped; a missing or other one is a changed request. */
  const answerCode = (body: unknown): string | null => {
    const parsed = AnswerSchema.safeParse(body)
    return parsed.success ? parsed.data.code : null
  }
  const answered = (reply: FastifyReply, result: 'ok' | 'notFound' | 'changed'): FastifyReply | null => {
    if (result === 'notFound') return fail(reply, 404, 'companion.requestNotFound')
    if (result === 'changed') return fail(reply, 409, 'companion.requestChanged')
    return null
  }

  app.post<Params>('/api/companion/requests/:requestId/approve', { onRequest: localOnly }, async (req, reply) => {
    const failed = answered(reply, await pairing.approve(req.params.requestId, answerCode(req.body)))
    if (failed) return failed
    req.log.info('companion pairing approved')
    return { ok: true }
  })

  app.post<Params>('/api/companion/requests/:requestId/refuse', { onRequest: localOnly }, async (req, reply) => {
    const failed = answered(reply, pairing.refuse(req.params.requestId, answerCode(req.body)))
    if (failed) return failed
    req.log.info('companion pairing refused')
    return { ok: true }
  })
}
