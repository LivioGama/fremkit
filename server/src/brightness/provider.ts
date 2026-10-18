import { z } from 'zod'
import type { CommandContext, Provider } from '../providers/types.js'
import { SCREEN_ID_RE, type Screen } from '../config/schema.js'
import { tr } from '../i18n.js'
import { BrightnessError, type BrightnessService } from './service.js'

/**
 * Every command names its screen, or none for the kiosk's. The host stamps `instanceId` onto a
 * widget's payloads too; zod's default `strip` drops it with anything else unexpected.
 */
const ScreenField = { screen: z.string().regex(SCREEN_ID_RE).optional() }
export const SetSchema = z.object({ ...ScreenField, value: z.number().finite() })
export const StepSchema = z.object({ ...ScreenField, delta: z.number().finite().min(-100).max(100) })
export const ResumeSchema = z.object({ ...ScreenField })

/** How often the schedule is re-read: a ramp moves one level every ten seconds or so. */
export const BRIGHTNESS_INTERVAL_MS = 5000

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload ?? {})
  if (!parsed.success) throw new Error(tr(undefined, 'provider.invalidPayload'))
  return parsed.data
}

/**
 * Whether the client that sent a command may change this screen's brightness.
 *
 * Today every client the server accepts is on this Mac or is refused: a command from a socket on
 * this machine may drive any screen, and one with no context or from elsewhere drives none.
 *
 * What device pairing plugs in here: a paired device's socket is remote (`isRemoteRequest(req)`
 * from `net/remote.ts`, carried into the `CommandContext` by the WebSocket route) and is bound to
 * one screen. Such a client must never drive an `edge` screen — the Edge sits on the user's desk —
 * and may drive only the `device` screen it is bound to, so the context it carries has to name
 * that screen and this function has to compare the two. Everything else stays refused.
 */
export function mayCommandBrightness(ctx: CommandContext | undefined, screen: Screen): boolean {
  void screen
  return ctx?.loopback === true
}

function run<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof BrightnessError) {
      throw new Error(tr(undefined, err.code === 'unknown-screen' ? 'brightness.unknownScreen' : 'brightness.unavailable'))
    }
    throw err
  }
}

/**
 * The `brightness` channel: every screen's level, target and mode (see `service.ts`).
 *
 * Polled every few seconds so the day/night ramp advances and an expired manual change gives way;
 * a command or a helper report asks for an immediate poll through `changed`, so a slider answers
 * at once. The registry only publishes when the snapshot actually changed.
 */
export function createBrightnessProvider(service: BrightnessService, changed: () => void = () => {}): Provider {
  const after = <T>(result: T): T => { changed(); return result }
  /** Fails closed: a caller with no context is treated as remote. */
  const guard = (screen: string | undefined, ctx: CommandContext | undefined): void => {
    run(() => {
      if (!mayCommandBrightness(ctx, service.screenOf(screen))) throw new Error(tr(undefined, 'provider.localOnly'))
    })
  }
  return {
    channel: 'brightness',
    intervalMs: BRIGHTNESS_INTERVAL_MS,
    poll: async () => service.snapshot(),
    commands: {
      set: async (payload, ctx) => {
        const { screen, value } = parse(SetSchema, payload)
        guard(screen, ctx)
        return after(run(() => service.set(screen, value)))
      },
      step: async (payload, ctx) => {
        const { screen, delta } = parse(StepSchema, payload)
        guard(screen, ctx)
        return after(run(() => service.step(screen, delta)))
      },
      resume: async (payload, ctx) => {
        const { screen } = parse(ResumeSchema, payload)
        guard(screen, ctx)
        return after(run(() => service.resume(screen)))
      },
    },
  }
}
