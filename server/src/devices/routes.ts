/**
 * The device routes. Two audiences, never mixed:
 *
 * - the admin, on this Mac: everything under `/api/devices` but `/me`. These are absent from the
 *   remote allow-list, so the devices gate already answers 404 on the remote listener; each one
 *   also refuses a remote request itself, in case the allow-list ever grows by mistake.
 * - a device, on the remote listener: `POST /api/pair` (public, it is how a token is obtained) and
 *   `GET /api/devices/me` (token). Pairing answers 404 locally: a code typed on the Mac itself
 *   would pair nothing that could use it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ConfigStore } from '../config/store.js'
import { tr, type MessageKey } from '../i18n.js'
import { isRemoteRequest, pairedDeviceOf } from '../net/remote.js'
import type { DeviceService } from './service.js'
import { ViewportSchema } from './store.js'

export interface DeviceRoutesOptions {
  service: DeviceService
  config: ConfigStore
}

const NameSchema = z.string().trim().min(1).max(60)

const PairSchema = z.object({
  code: z.string().max(64),
  name: NameSchema,
  viewport: ViewportSchema,
})

const SettingsSchema = z.object({ enabled: z.boolean() })

const PatchSchema = z.object({
  name: NameSchema.optional(),
  screenId: z.string().min(1).max(64).nullable().optional(),
})

function badBody(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({ errors: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
}

const PAIR_ERRORS: Record<'wrong' | 'expired' | 'limited', { status: 403 | 429; key: MessageKey }> = {
  wrong: { status: 403, key: 'device.codeWrong' },
  expired: { status: 403, key: 'device.codeExpired' },
  limited: { status: 429, key: 'device.codeLimited' },
}

export async function deviceRoutes(app: FastifyInstance, opts: DeviceRoutesOptions): Promise<void> {
  const { service } = opts
  const locale = () => opts.config.get().locale

  /** The admin routes are this Mac's only. */
  const localOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (isRemoteRequest(req)) return reply.callNotFound()
  }

  // --- the device -------------------------------------------------------------------------------

  app.post('/api/pair', async (req, reply) => {
    if (!isRemoteRequest(req)) return reply.callNotFound()
    reply.header('cache-control', 'no-store')
    const parsed = PairSchema.safeParse(req.body)
    if (!parsed.success) return badBody(reply, parsed.error)
    const { code, name, viewport } = parsed.data
    const result = await service.pair(code.trim().toUpperCase(), name, viewport)
    if ('error' in result) {
      const { status, key } = PAIR_ERRORS[result.error]
      return reply.code(status).send({ error: tr(locale(), key) })
    }
    return { token: result.token, deviceId: result.device.id }
  })

  app.get('/api/devices/me', async (req, reply) => {
    // Who is asking comes from the token the gate checked, and from nothing the request says.
    const deviceId = pairedDeviceOf(req)
    if (!isRemoteRequest(req) || deviceId === null) return reply.callNotFound()
    const me = service.me(deviceId)
    if (!me) return reply.code(401).send({ error: tr(locale(), 'devices.unauthorized') })
    reply.header('cache-control', 'no-store')
    return me
  })

  // --- the admin --------------------------------------------------------------------------------

  app.get('/api/devices', { onRequest: localOnly }, async (_req, reply) => {
    await service.loadKeyHash()
    reply.header('cache-control', 'no-store')
    return service.status()
  })

  app.put('/api/devices/settings', { onRequest: localOnly }, async (req, reply) => {
    const parsed = SettingsSchema.safeParse(req.body)
    if (!parsed.success) return badBody(reply, parsed.error)
    const result = await service.setEnabled(parsed.data.enabled)
    return {
      ...service.status(),
      ...(result.error === 'portInUse' ? { message: tr(locale(), 'device.portInUse') } : {}),
    }
  })

  app.post('/api/devices/code', { onRequest: localOnly }, async (_req, reply) => {
    if (!service.listening) return reply.code(409).send({ error: tr(locale(), 'device.notEnabled') })
    reply.header('cache-control', 'no-store')
    return service.pairingCode()
  })

  app.patch<{ Params: { id: string } }>('/api/devices/:id', { onRequest: localOnly }, async (req, reply) => {
    const parsed = PatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return badBody(reply, parsed.error)
    const { id } = req.params
    if (!service.me(id)) return reply.code(404).send({ errors: [tr(locale(), 'device.notFound')] })
    if (parsed.data.screenId !== undefined) {
      const attached = await service.attach(id, parsed.data.screenId)
      if (attached === 'screenNotDevice') {
        return reply.code(400).send({ errors: [tr(locale(), 'device.screenNotDevice')] })
      }
    }
    if (parsed.data.name !== undefined) await service.rename(id, parsed.data.name)
    const device = service.status().devices.find((d) => d.id === id)
    if (!device) return reply.code(404).send({ errors: [tr(locale(), 'device.notFound')] })
    return device
  })

  app.delete<{ Params: { id: string } }>('/api/devices/:id', { onRequest: localOnly }, async (req, reply) => {
    if (!(await service.revoke(req.params.id))) {
      return reply.code(404).send({ errors: [tr(locale(), 'device.notFound')] })
    }
    return reply.code(204).send()
  })

  app.delete('/api/devices', { onRequest: localOnly }, async (_req, reply) => {
    await service.revokeAll()
    return reply.code(204).send()
  })

  app.post('/api/devices/reset-certificate', { onRequest: localOnly }, async () => {
    await service.resetCertificate()
    return service.status()
  })
}
