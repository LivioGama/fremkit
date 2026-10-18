import type { Config } from '../config/schema.js'

/**
 * Channels the dashboard page subscribes to itself, outside any widget. A paired device shows
 * that page, so it needs them whatever its screen holds. Checked with
 * `grep subscribe( ui/src` over the dashboard and the shared frame code: the page listens to
 * `config`, and every widget frame to `widget-dev` (`ui/src/shared/widgetDev.ts`), which carries
 * nothing but the ids of widgets whose files were just saved and is silent unless the server
 * runs with `FREMKIT_WIDGET_DEV=1`. `theme` is the theme in force, day or night
 * (`themes/schedule.ts`): an id, a phase and the time of the next switch.
 */
export const HOST_CHANNELS: readonly string[] = ['config', 'widget-dev', 'theme']

/**
 * The channel a paired socket hears about its own device on (its screen, its name). Reserved in
 * the manifest schema so no widget can declare it, and never fanned out by `Hub.broadcast`.
 */
export const DEVICE_CHANNEL = 'device'

/** What the channel policy needs from a widget's manifest: the granted one, not the raw file. */
export interface ChannelManifest {
  subscriptions: string[]
  commands: string[]
  settingsSchema?: Record<string, { preview?: { channel: string } }>
}

export interface ScreenChannels {
  subscriptions: string[]
  commands: string[]
}

/**
 * Whether a list of manifest entries covers a channel. An entry is a literal channel name or a
 * prefix ending in `:*` covering every per-connection channel of that type. The same rule as
 * `channelAllowed` in `ui/src/shared/types.ts`, which the widget bridge applies in the browser;
 * this one is the server's, and the one a paired device cannot get around.
 */
export function channelAllowed(allowed: readonly string[], channel: string): boolean {
  for (const entry of allowed) {
    if (entry === channel) return true
    if (entry.endsWith(':*') && channel.startsWith(entry.slice(0, -1))) return true
  }
  return false
}

/**
 * The channels the widgets of one screen may subscribe to and command: every widget placed on
 * any of its pages, and every widget in its navigation bar. A settings field's `preview` is one of
 * the widget's commands and adds nothing of its own. `manifests` is the granted catalogue
 * (`grantedCatalog`), so a channel the user did not consent to is not here either.
 *
 * An unknown screen, an instance missing from `config.widgets` or a widget with no manifest
 * contributes nothing: the policy only ever narrows.
 */
export function screenChannels(
  config: Config,
  screenId: string,
  manifests: Map<string, ChannelManifest>,
): ScreenChannels {
  const subscriptions = new Set<string>()
  const commands = new Set<string>()
  const screen = config.screens.find((s) => s.id === screenId)
  if (!screen) return { subscriptions: [], commands: [] }
  const instanceIds = [
    ...screen.pages.flatMap((page) => page.items.map((item) => item.instanceId)),
    ...screen.nav.map((item) => item.instanceId),
  ]
  for (const instanceId of instanceIds) {
    const widgetId = config.widgets[instanceId]?.widgetId
    const manifest = widgetId === undefined ? undefined : manifests.get(widgetId)
    if (!manifest) continue
    for (const ch of manifest.subscriptions) subscriptions.add(ch)
    // A settings preview adds nothing: its channel has to be one of `commands` (the manifest
    // schema says so, and the grant drops a preview its commands no longer cover), so it is
    // already here — and a device must not gain a channel the user never agreed to through it.
    for (const ch of manifest.commands) commands.add(ch)
  }
  return { subscriptions: [...subscriptions], commands: [...commands] }
}
