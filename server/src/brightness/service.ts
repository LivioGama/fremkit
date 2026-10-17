/**
 * Brightness, per screen: what each screen's *target* reports, what the user asked for, and what
 * the automatic modes want — folded into one snapshot on the `brightness` channel.
 *
 * The server is the brain and the targets are the hands. A target is whatever can actually
 * change a screen's brightness and say what it is:
 *
 * - the **helper**, for the screen the kiosk shows: it reports over `POST /api/hooks/brightness`
 *   (DDC availability, the level it read back, the Mac's built-in display) and applies the
 *   `target` it reads from this channel, which it subscribes to like any widget;
 * - later, the **paired device's app**, for a `device` screen, with `UIScreen.brightness`. Until
 *   it exists a device screen reports `device-unsupported`, and the controls say so.
 *
 * Keeping the decisions here rather than in the helper is what lets an iPad follow the same
 * day/night schedule as the Edge without a second implementation of it.
 */

import { z } from 'zod'
import type { Config, Screen } from '../config/schema.js'
import { SCREEN_ID_RE } from '../config/schema.js'
import { decide, type BrightnessMode, type Held } from './decide.js'

/** With no report from the helper for this long, its screen is considered unreachable. */
export const HELPER_STALE_MS = 30_000

/** What the helper says about the kiosk's display. Validated in full: it arrives over HTTP. */
export const HelperReportSchema = z.object({
  /** The screen the kiosk shows, from its `?screen=`; null for the default (first Edge screen). */
  screen: z.string().regex(SCREEN_ID_RE).nullable().default(null),
  available: z.boolean(),
  reason: z.enum(['no-display', 'no-ddc', 'ambiguous']).optional(),
  value: z.number().int().min(0).max(100).nullable().default(null),
  /** The display's product name, as the monitor reports it; shown in the admin. */
  display: z.string().max(80).optional(),
  /** The Mac's built-in display, 0–1, or null when it has none or it is off. */
  builtin: z.number().min(0).max(1).nullable().default(null),
  /** The last `seq` of the kiosk screen the helper has written and read back, if any. */
  applied: z.number().int().min(0).optional(),
})
export type HelperReport = z.infer<typeof HelperReportSchema>

export type Unavailable = 'no-helper' | 'no-display' | 'no-ddc' | 'ambiguous' | 'device-unsupported'

export interface ScreenBrightness {
  available: boolean
  reason?: Unavailable
  /** The level the screen is at, as best known: read back from it, or what was last sent. */
  value: number | null
  /** What the target should put the screen at, or null for "leave it alone". */
  target: number | null
  /** Bumped whenever a new target is decided, so "set 50 again" after the OSD moved it still applies. */
  seq: number
  mode: BrightnessMode
  overridden: boolean
  dayNightProblem?: 'no-location'
  followProblem?: 'no-builtin'
  phase?: { state: 'day' | 'night' | 'dimming' | 'brightening'; next?: { at: string; to: 'day' | 'night' } }
  /** True when the Mac has a built-in display to follow (as far as this screen's target knows). */
  builtin: boolean
  display?: string
}

export interface BrightnessSnapshot {
  /** The screen the helper's kiosk drives, or null when no screen is an Edge screen. */
  kiosk: string | null
  screens: Record<string, ScreenBrightness>
}

interface Runtime { held: Held | null; target: number | null; seq: number; sent: number | null }

export interface BrightnessServiceOptions {
  config: () => Config
  now?: () => number
}

/** Errors a command can end in; the provider turns them into localized messages. */
export class BrightnessError extends Error {
  constructor(readonly code: 'unknown-screen' | 'unavailable') { super(code) }
}

export class BrightnessService {
  private readonly now: () => number
  private report: HelperReport | null = null
  private reportedAt = 0
  private readonly runtime = new Map<string, Runtime>()

  constructor(private readonly opts: BrightnessServiceOptions) {
    this.now = opts.now ?? Date.now
  }

  /** Takes a report from the helper (already validated). */
  helperReport(report: HelperReport): void {
    this.report = report
    this.reportedAt = this.now()
    // Once the helper has written the latest target and read the display back, what it read is
    // the truth — including a level changed later on the monitor's own buttons.
    const kiosk = this.kioskScreen()
    const r = kiosk && this.runtime.get(kiosk.id)
    if (r && report.applied !== undefined && report.applied >= r.seq) r.sent = null
  }

  /** The screen the helper drives: the one it names when that is an Edge screen, else the first Edge screen. */
  kioskScreen(config = this.opts.config()): Screen | undefined {
    const edges = config.screens.filter((s) => s.kind === 'edge')
    return edges.find((s) => s.id === this.report?.screen) ?? edges[0]
  }

  private helperFresh(): boolean {
    return this.report !== null && this.now() - this.reportedAt < HELPER_STALE_MS
  }

  private rt(id: string): Runtime {
    let r = this.runtime.get(id)
    if (!r) { r = { held: null, target: null, seq: 0, sent: null }; this.runtime.set(id, r) }
    return r
  }

  /** What stops a screen from being driven, or undefined when it can be. */
  private unavailable(screen: Screen, kioskId: string | undefined): Unavailable | undefined {
    if (screen.kind === 'device') return 'device-unsupported'
    // Several Edges on one Mac is step 4 of the screens spec: only the kiosk's screen has a hand.
    if (screen.id !== kioskId || !this.helperFresh()) return 'no-helper'
    if (!this.report!.available) return this.report!.reason ?? 'no-ddc'
    return undefined
  }

  private builtin(): number | null {
    return this.helperFresh() ? this.report!.builtin : null
  }

  private resolve(screenId: string | undefined): Screen {
    const config = this.opts.config()
    const screen = screenId === undefined ? this.kioskScreen(config) : config.screens.find((s) => s.id === screenId)
    if (!screen) throw new BrightnessError('unknown-screen')
    if (this.unavailable(screen, this.kioskScreen(config)?.id)) throw new BrightnessError('unavailable')
    return screen
  }

  /** A person chose a level, from the widget, the admin or the helper's menu. */
  set(screenId: string | undefined, value: number): { screen: string; value: number } {
    const screen = this.resolve(screenId)
    const level = Math.max(0, Math.min(100, Math.round(value)))
    const r = this.rt(screen.id)
    const mode = decide({ settings: screen.brightness, now: this.now(), builtin: this.builtin(), held: null }).mode
    r.held = { value: level, at: this.now(), mode, builtin: this.builtin() }
    r.target = level
    r.sent = level
    r.seq++
    return { screen: screen.id, value: level }
  }

  /** The −/+ buttons: a step from the level the screen is at now. */
  step(screenId: string | undefined, delta: number): { screen: string; value: number } {
    const screen = this.resolve(screenId)
    const current = this.snapshot().screens[screen.id]
    const from = current?.value ?? current?.target ?? 50
    return this.set(screen.id, from + delta)
  }

  /** "Back to automatic": drops a manual change that holds a mode back. */
  resume(screenId: string | undefined): { screen: string } {
    const screen = this.resolve(screenId)
    this.rt(screen.id).held = null
    return { screen: screen.id }
  }

  /**
   * Decides every screen's target at this instant and describes the lot. Called on every poll,
   * so a ramp moves and an expired manual change gives way without anybody asking.
   */
  snapshot(): BrightnessSnapshot {
    const config = this.opts.config()
    const kiosk = this.kioskScreen(config)
    const now = this.now()
    const screens: Record<string, ScreenBrightness> = {}
    for (const screen of config.screens) {
      const r = this.rt(screen.id)
      const reason = this.unavailable(screen, kiosk?.id)
      const builtin = this.builtin()
      const d = decide({ settings: screen.brightness, now, builtin, held: r.held })
      if (d.releaseHeld) r.held = null
      if (!reason && d.target !== null && d.target !== r.target) {
        r.target = d.target
        r.sent = d.target
        r.seq++
      }
      const isKiosk = screen.id === kiosk?.id && this.helperFresh()
      const read = isKiosk ? this.report!.value : null
      screens[screen.id] = {
        available: reason === undefined,
        ...(reason ? { reason } : {}),
        // What was sent wins over a read-back that predates it: the slider must not jump back
        // while the display catches up. The helper reads back after every write anyway.
        value: reason ? null : r.sent ?? read,
        target: reason ? null : r.target,
        seq: r.seq,
        mode: d.mode,
        overridden: d.overridden,
        ...(d.dayNightProblem ? { dayNightProblem: d.dayNightProblem } : {}),
        ...(d.followProblem ? { followProblem: d.followProblem } : {}),
        ...(d.phase ? { phase: { state: d.phase.state, ...(d.phase.next ? { next: { at: new Date(d.phase.next.at).toISOString(), to: d.phase.next.to } } : {}) } } : {}),
        builtin: isKiosk && this.report!.builtin !== null,
        ...(isKiosk && this.report!.display ? { display: this.report!.display } : {}),
      }
    }
    return { kiosk: kiosk?.id ?? null, screens }
  }
}
