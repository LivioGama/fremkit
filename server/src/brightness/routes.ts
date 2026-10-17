import type { FastifyInstance } from 'fastify'
import { isLoopbackAddress } from '../net/loopback.js'
import { tr } from '../i18n.js'
import { HelperReportSchema, type BrightnessService } from './service.js'

/**
 * Where the helper reports the kiosk display's brightness, the way it reports the Dock: a small
 * JSON body, from this machine, carrying the access secret like every request. The other half of
 * the conversation — the target to apply — goes the other way on the `brightness` channel of the
 * WebSocket, which the helper subscribes to.
 */
export async function brightnessRoutes(app: FastifyInstance, opts: { service: BrightnessService; changed: () => void }): Promise<void> {
  app.post('/api/hooks/brightness', { bodyLimit: 4096 }, async (req, reply) => {
    if (!isLoopbackAddress(req.ip)) return reply.code(403).send({ error: tr(undefined, 'dock.notLocal') })
    const parsed = HelperReportSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: tr(undefined, 'provider.invalidPayload') })
    opts.service.helperReport(parsed.data)
    opts.changed()
    return reply.code(204).send()
  })
}
