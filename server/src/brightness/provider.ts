import { z } from 'zod'
import type { Provider } from '../providers/types.js'
import { SCREEN_ID_RE } from '../config/schema.js'
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
  return {
    channel: 'brightness',
    intervalMs: BRIGHTNESS_INTERVAL_MS,
    poll: async () => service.snapshot(),
    commands: {
      set: async (payload) => {
        const { screen, value } = parse(SetSchema, payload)
        return after(run(() => service.set(screen, value)))
      },
      step: async (payload) => {
        const { screen, delta } = parse(StepSchema, payload)
        return after(run(() => service.step(screen, delta)))
      },
      resume: async (payload) => {
        const { screen } = parse(ResumeSchema, payload)
        return after(run(() => service.resume(screen)))
      },
    },
  }
}
