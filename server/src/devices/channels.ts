import type { Config } from '../config/schema.js'

/** One connection as the channel policy needs it: enough to name the channel it publishes on. */
export interface ChannelConnection { id: string; type: string }

/**
 * Channels the dashboard page subscribes to itself, outside any widget. A paired device shows
 * that page, so it needs them whatever its screen holds. Checked with
 * `grep subscribe( ui/src/dashboard`: the page listens to `config` and nothing else.
 */
export const HOST_CHANNELS: readonly string[] = ['config']

/**
 * The channel a paired socket hears about its own device on (its screen, its name). Reserved in
 * the manifest schema so no widget can declare it, and never fanned out by `Hub.broadcast`.
 */
export const DEVICE_CHANNEL = 'device'

/** What the channel policy needs from a widget's manifest: the granted one, not the raw file. */
export interface ChannelManifest {
  subscriptions: string[]
  commands: string[]
  settingsSchema?: Record<string, { type?: string; preview?: { channel: string } }>
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

/** The connection ids an instance's settings name, through its `connection`/`connections` fields. */
function referencedConnections(manifest: ChannelManifest, settings: Record<string, unknown>): string[] {
  const ids: string[] = []
  for (const [key, field] of Object.entries(manifest.settingsSchema ?? {})) {
    if (!Object.hasOwn(settings, key)) continue
    const value = settings[key]
    if (field.type === 'connection' && typeof value === 'string') ids.push(value)
    if (field.type === 'connections' && Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string') ids.push(v)
    }
  }
  return ids
}

/**
 * The channels the widgets of one screen may subscribe to and command: every widget placed on
 * any of its pages, and every widget in its navigation bar. A settings field's `preview` runs a
 * command, so its channel counts as a command channel. `manifests` is the granted catalogue
 * (`grantedCatalog`), so a channel the user did not consent to is not here either.
 *
 * Per-connection channels are narrowed to the connections the screen actually uses. A manifest's
 * `<type>:*` says "the channel of whichever connection the user binds me to", not "every
 * connection of that type": left as a wildcard, a calendar on the iPad would let it hear the
 * work calendar shown only on the Edge, and a GitHub widget act on another account. So a wildcard
 * becomes the concrete channels of the connections the screen's instances name in their
 * `connection`/`connections` settings, and a literal entry naming some connection's channel stays
 * only if one of those instances names that connection. The result holds no wildcard at all.
 * `channelOf` is `ConnectionManager.channelFor` (an `ics` connection publishes on `calendar:`).
 *
 * An unknown screen, an instance missing from `config.widgets` or a widget with no manifest
 * contributes nothing: the policy only ever narrows.
 */
export function screenChannels(
  config: Config,
  screenId: string,
  manifests: Map<string, ChannelManifest>,
  channelOf: (connection: ChannelConnection) => string = (c) => `${c.type}:${c.id}`,
): ScreenChannels {
  const subscriptions = new Set<string>()
  const commands = new Set<string>()
  const screen = config.screens.find((s) => s.id === screenId)
  if (!screen) return { subscriptions: [], commands: [] }
  const instanceIds = [
    ...screen.pages.flatMap((page) => page.items.map((item) => item.instanceId)),
    ...screen.nav.map((item) => item.instanceId),
  ]
  const byId = new Map(config.connections.map((c) => [c.id, c]))
  const connectionChannels = new Set(config.connections.map((c) => channelOf(c)))
  for (const instanceId of instanceIds) {
    if (!Object.hasOwn(config.widgets, instanceId)) continue
    const instance = config.widgets[instanceId]
    const manifest = manifests.get(instance.widgetId)
    if (!manifest) continue
    const own = referencedConnections(manifest, instance.settings)
      .map((id) => byId.get(id))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => channelOf(c))
    const grant = (entry: string, into: Set<string>): void => {
      if (entry.endsWith(':*')) {
        for (const ch of own) if (channelAllowed([entry], ch)) into.add(ch)
      } else if (!connectionChannels.has(entry) || own.includes(entry)) {
        into.add(entry)
      }
    }
    for (const ch of manifest.subscriptions) grant(ch, subscriptions)
    for (const ch of manifest.commands) grant(ch, commands)
    for (const field of Object.values(manifest.settingsSchema ?? {})) {
      if (field.preview) grant(field.preview.channel, commands)
    }
  }
  return { subscriptions: [...subscriptions], commands: [...commands] }
}
