import type { Config, LayoutManifest, Screen } from './schema.js'

/**
 * The navigation bar's width rule, on the server: how many cells each compact widget takes and
 * how many a screen's bar may hold. The admin applies the same rule as the user edits; the server
 * applies it again at save, where a setting changed on a widget shared by several screens can
 * overflow the bar of a screen the admin is not showing.
 */

/** Cells kept free in the middle of the bar for the page dots. Mirrors `ui/src/shared/types.ts`. */
export const NAV_DOTS_RESERVE_CELLS = 10

/**
 * The settings that make a compact widget need more room than its manifest asks for.
 * Mirrors `ui/src/shared/types.ts`.
 */
export const WIDE_COMPACT_SETTINGS = ['compactDate', 'compactCities'] as const

/** The width a compact widget gets when one of those settings is on. Mirrors `ui/src/shared/types.ts`. */
export const WIDE_COMPACT_WIDTH = 8

/**
 * How many cells the bar allots one compact widget: what its manifest declares, widened when a
 * wide setting is on — in the instance's settings or, failing that, as the manifest's default,
 * exactly as the UI merges them. 0 when the widget has no compact rendering.
 */
export function compactWidth(manifest: LayoutManifest | undefined, settings: Record<string, unknown>): number {
  const base = manifest?.compact?.width ?? 0
  if (!base) return 0
  const merged: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(manifest?.settingsSchema ?? {})) merged[k] = f.default
  Object.assign(merged, settings)
  const wide = WIDE_COMPACT_SETTINGS.some((key) => merged[key] === true)
  return wide ? Math.max(base, WIDE_COMPACT_WIDTH) : base
}

/** The cells one screen's bar takes; an entry naming a missing or unknown widget counts 0. */
export function navCellsUsed(screen: Screen, widgets: Config['widgets'], manifests: Map<string, LayoutManifest>): number {
  return screen.nav.reduce((sum, item) => {
    const widget = widgets[item.instanceId]
    return widget ? sum + compactWidth(manifests.get(widget.widgetId), widget.settings) : sum
  }, 0)
}
