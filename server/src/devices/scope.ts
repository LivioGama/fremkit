/**
 * Which screen a caller may act on: the one rule the proxy, the commands that resolve an instance
 * and the config a device reads all apply.
 *
 * A caller on this Mac acts on every screen, as it always has. A paired device acts on the one
 * device screen it is attached to and on nothing else: an instance id it names is not a capability,
 * and an instance placed only on the Edge, or on another device's screen, is not its to use. A
 * device with no screen acts on nothing.
 */

import type { FastifyRequest } from 'fastify'
import type { Config } from '../config/schema.js'
import type { CommandContext } from '../providers/types.js'
import { isRemoteRequest, pairedDeviceOf } from '../net/remote.js'

export type ScreenScope =
  | { kind: 'all' }
  | { kind: 'screen'; screenId: string }
  | { kind: 'none' }

/**
 * The device screen a paired device is attached to, or null when it has none (or no longer
 * exists). Production passes `DeviceService.deviceScreenOf`, read at call time, so a device moved
 * to another screen or unpaired is judged as it is now.
 */
export type ScreenOfDevice = (deviceId: string) => string | null

const ALL: ScreenScope = { kind: 'all' }
const NONE: ScreenScope = { kind: 'none' }

function deviceScope(deviceId: string | null | undefined, screenOf: ScreenOfDevice): ScreenScope {
  if (deviceId === null || deviceId === undefined) return NONE
  let screenId: string | null
  try { screenId = screenOf(deviceId) } catch { return NONE }
  return screenId === null ? NONE : { kind: 'screen', screenId }
}

/**
 * The scope of an HTTP request. Local or remote is the socket's answer (`net/remote.ts`); a remote
 * request the devices gate did not tie to a device acts on nothing.
 */
export function requestScope(req: FastifyRequest, screenOf: ScreenOfDevice): ScreenScope {
  if (!isRemoteRequest(req)) return ALL
  return deviceScope(pairedDeviceOf(req), screenOf)
}

/**
 * The scope of a WebSocket command. A paired socket is scoped to its device; a socket on this
 * machine acts on everything. Fails closed: no context, or a context that is neither, is nothing.
 */
export function commandScope(ctx: CommandContext | undefined, screenOf: ScreenOfDevice): ScreenScope {
  if (ctx?.paired === true) return deviceScope(ctx.deviceId, screenOf)
  if (ctx?.loopback === true) return ALL
  return NONE
}

/** The instance ids one screen shows: on any of its pages, and in its bar. */
export function screenInstanceIds(config: Config, screenId: string): Set<string> {
  const screen = config.screens.find((s) => s.id === screenId)
  if (!screen) return new Set()
  return new Set([
    ...screen.pages.flatMap((page) => page.items.map((item) => item.instanceId)),
    ...screen.nav.map((item) => item.instanceId),
  ])
}

/** Whether `instanceId` may be acted on within `scope`. */
export function instanceInScope(config: Config, scope: ScreenScope, instanceId: string): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'none') return false
  return screenInstanceIds(config, scope.screenId).has(instanceId)
}

/** Whether some instance of `widgetId` is shown within `scope`. */
export function widgetInScope(config: Config, scope: ScreenScope, widgetId: string): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'none') return false
  for (const instanceId of screenInstanceIds(config, scope.screenId)) {
    if (Object.hasOwn(config.widgets, instanceId) && config.widgets[instanceId].widgetId === widgetId) return true
  }
  return false
}
