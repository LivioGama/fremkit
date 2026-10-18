import { execFile } from 'node:child_process'
import { homedir, hostname, release, userInfo } from 'node:os'
import type { Config, Connection } from '../config/schema.js'
import { CONFIG_VERSION } from '../config/schema.js'
import type { ChannelStatus } from '../providers/registry.js'
import type { WidgetSource } from '../widgets/catalog.js'
import { FREMKIT_VERSION } from '../version.js'
import { hostOf, redact, type RedactionContext } from './redact.js'
import type { LogSource } from './log-tail.js'

/** Lines of the server log a report carries. */
export const LOG_LINES = 200

/**
 * Everything a report says, gathered first and rendered second so the rendering can be tested
 * on a fixture. Nothing here is a name the user typed, a URL or a credential: those are the
 * redaction context's business, and never reach the text except through a log line.
 */
export interface DiagnosticsFacts {
  generatedAt: string
  version: string
  install: 'checkout' | 'app'
  dev: boolean
  node: string
  macos: string | null
  darwin: string
  arch: string
  configVersion: number
  theme: string
  locale: string
  secretsBackend: string
  screens: { edge: number; device: number }
  pages: number
  /** Widget instances in the config, placed or in a bar. */
  instances: number
  widgets: { id: string; version: string | null; source: WidgetSource | 'missing'; instances: number }[]
  connections: { type: string; kind: 'coded' | 'declared' | 'unknown'; state: string }[]
  providers: { channel: string; watched: boolean; state: string }[]
  devices: { paired: number; remoteAccess: boolean }
  log: LogSource | null
}

const SOURCE_LABEL: Record<DiagnosticsFacts['widgets'][number]['source'], string> = {
  builtin: 'built-in',
  installed: 'Sietch',
  missing: 'missing',
}

/** The report, as Markdown that reads well both pasted in an issue and as plain text. */
export function renderReport(f: DiagnosticsFacts): string {
  const out: string[] = []
  out.push('## Fremkit diagnostics', '')
  out.push(`- Generated: ${f.generatedAt}`)
  out.push(`- Fremkit: ${f.version} (${f.install}${f.dev ? ', FREMKIT_DEV=1' : ''})`)
  out.push(`- macOS: ${f.macos ?? 'unknown'} (Darwin ${f.darwin}), ${f.arch}`)
  out.push(`- Node: ${f.node}`)
  out.push(`- Config schema: v${f.configVersion}`)
  out.push(`- Theme: ${f.theme}`)
  out.push(`- Language: ${f.locale}`)
  out.push(`- Secrets backend: ${f.secretsBackend}`)
  out.push(`- Screens: ${f.screens.edge + f.screens.device} (edge ${f.screens.edge}, device ${f.screens.device})`)
  out.push(`- Pages: ${f.pages}`)
  out.push(`- Widget instances: ${f.instances}`)
  out.push(`- Paired devices: ${f.devices.paired} (remote access ${f.devices.remoteAccess ? 'on' : 'off'})`)
  out.push('')

  out.push('### Widgets in use', '')
  if (f.widgets.length === 0) out.push('None.')
  else {
    out.push('| Widget | Version | Source | Instances |', '|---|---|---|---|')
    for (const w of f.widgets) out.push(`| ${w.id} | ${w.version ?? '–'} | ${SOURCE_LABEL[w.source]} | ${w.instances} |`)
  }
  out.push('')

  out.push('### Connections', '')
  if (f.connections.length === 0) out.push('None.')
  else {
    out.push('| Type | Kind | State |', '|---|---|---|')
    for (const c of f.connections) out.push(`| ${c.type} | ${c.kind} | ${c.state} |`)
  }
  out.push('')

  out.push('### Providers', '')
  if (f.providers.length === 0) out.push('None.')
  else {
    out.push('| Channel | Watched | Last poll |', '|---|---|---|')
    for (const p of f.providers) out.push(`| ${p.channel} | ${p.watched ? 'yes' : 'no'} | ${p.state} |`)
  }
  out.push('')

  if (f.log) {
    const where = f.log.kind === 'file' ? 'server.log' : 'since this server started'
    out.push(`### Server log (last ${f.log.lines.length} lines, ${where}, redacted)`, '')
    out.push('```text', ...f.log.lines.map((l) => l.replace(/```/g, "'''")), '```')
  } else {
    out.push('### Server log', '', 'Not available.')
  }
  out.push('')
  return out.join('\n')
}

/** What a channel's last poll is reported as. */
function pollState(status: ChannelStatus | undefined): string {
  if (!status || status.lastError === undefined) return 'not polled'
  return status.lastError === null ? 'ok' : `error: ${status.lastError}`
}

/** What the collector needs from the running server. Plain functions, so a test can fake each. */
export interface DiagnosticsDeps {
  config: () => Config
  /** Built-in or installed, and the version, of a widget id the catalogue knows. */
  widget: (id: string) => { version: string; source: WidgetSource } | undefined
  /** Whether a connection type is known, and whether a widget declared it. */
  connectionKind: (type: string) => 'coded' | 'declared' | 'unknown'
  channelFor: (connection: Connection) => string
  secretsFor: (connection: Connection) => Promise<Record<string, string>>
  channels: () => ChannelStatus[]
  devices: () => { name: string }[]
  remoteAccess: () => boolean
  accessToken: string | null
  log?: (count: number) => Promise<LogSource>
  /** Overridable for the tests; the real ones read the Mac. */
  system?: Partial<SystemFacts>
  now?: () => Date
}

export interface SystemFacts {
  node: string
  macos: string | null
  darwin: string
  arch: string
  home: string
  username: string
  machineNames: string[]
  install: 'checkout' | 'app'
  dev: boolean
}

/** A program's trimmed output, or null; never throws, never waits more than two seconds. */
function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 2000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null))
  })
}

export async function readSystemFacts(env: NodeJS.ProcessEnv = process.env): Promise<SystemFacts> {
  const [macos, computerName, localHostName] = await Promise.all([
    run('/usr/bin/sw_vers', ['-productVersion']),
    run('/usr/sbin/scutil', ['--get', 'ComputerName']),
    run('/usr/sbin/scutil', ['--get', 'LocalHostName']),
  ])
  let username = ''
  try { username = userInfo().username } catch { username = '' }
  const host = hostname()
  const names = [host, host.replace(/\.local$/i, ''), computerName, localHostName]
  return {
    node: process.version,
    macos,
    darwin: release(),
    arch: process.arch,
    home: homedir(),
    username,
    machineNames: names.filter((n): n is string => typeof n === 'string' && n.length > 0),
    install: env.FREMKIT_ROOT ? 'app' : 'checkout',
    dev: env.FREMKIT_DEV === '1',
  }
}

/** Counts every instance id a screen shows, grid and bar alike, once per instance. */
function widgetUsage(config: Config): Map<string, number> {
  const counts = new Map<string, number>()
  for (const widget of Object.values(config.widgets)) {
    counts.set(widget.widgetId, (counts.get(widget.widgetId) ?? 0) + 1)
  }
  return counts
}

/**
 * Builds the report: gathers the facts, renders them, and passes the whole text — not only the
 * log — through `redact()`, so nothing a later edit adds to the facts can slip past it.
 */
export async function buildDiagnostics(deps: DiagnosticsDeps): Promise<string> {
  const config = deps.config()
  const system = { ...(await readSystemFactsUnlessGiven(deps.system)) }
  const statuses = new Map(deps.channels().map((s) => [s.channel, s]))

  const connectionChannels = new Map<string, string>()
  const connections: DiagnosticsFacts['connections'] = []
  const secrets: string[] = []
  const hosts: string[] = []
  const names: string[] = []
  const typeCounters = new Map<string, number>()
  for (const connection of config.connections) {
    const kind = deps.connectionKind(connection.type)
    const channel = deps.channelFor(connection)
    const n = (typeCounters.get(connection.type) ?? 0) + 1
    typeCounters.set(connection.type, n)
    connectionChannels.set(channel, `${connection.type} #${n}`)
    const status = statuses.get(channel)
    connections.push({
      type: connection.type,
      kind,
      // A declared connection has no provider: the widget calls it through the proxy.
      state: status ? pollState(status) : kind === 'declared' ? 'used through the proxy' : 'no provider',
    })
    try {
      secrets.push(...Object.values(await deps.secretsFor(connection)))
    } catch {
      // A keychain that will not answer still leaves the shape rules to catch a leak.
    }
    for (const value of Object.values(connection.fields)) {
      const host = hostOf(value)
      if (host) hosts.push(host)
    }
    names.push(connection.name)
  }

  const usage = widgetUsage(config)
  const widgets: DiagnosticsFacts['widgets'] = [...usage.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, instances]) => {
      const known = deps.widget(id)
      return { id, version: known?.version ?? null, source: known?.source ?? 'missing', instances }
    })

  // A connection's channel is named after its id, which the user may have derived from a name:
  // shown as its type and rank instead.
  const providers = deps.channels()
    .map((s) => ({
      channel: connectionChannels.get(s.channel) ?? (s.channel.includes(':') ? `${s.channel.split(':')[0]}:…` : s.channel),
      watched: s.watched,
      state: pollState(s),
    }))
    .sort((a, b) => a.channel.localeCompare(b.channel))

  const pairedDevices = deps.devices()
  names.push(...pairedDevices.map((d) => d.name))
  names.push(...config.screens.filter((s) => s.kind === 'device').map((s) => s.name))
  if (deps.accessToken) secrets.push(deps.accessToken)

  const facts: DiagnosticsFacts = {
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    version: FREMKIT_VERSION,
    install: system.install,
    dev: system.dev,
    node: system.node,
    macos: system.macos,
    darwin: system.darwin,
    arch: system.arch,
    configVersion: config.version ?? CONFIG_VERSION,
    theme: config.theme,
    locale: config.locale,
    secretsBackend: config.secrets.backend,
    screens: {
      edge: config.screens.filter((s) => s.kind === 'edge').length,
      device: config.screens.filter((s) => s.kind === 'device').length,
    },
    pages: config.screens.reduce((sum, s) => sum + s.pages.length, 0),
    instances: Object.keys(config.widgets).length,
    widgets,
    connections,
    providers,
    devices: { paired: pairedDevices.length, remoteAccess: deps.remoteAccess() },
    log: deps.log ? await deps.log(LOG_LINES).catch(() => null) : null,
  }

  // A name equal to a widget or type id would blank that id out of the tables: the id says
  // nothing about the user, and the name is then not worth more than the id.
  const reserved = new Set([
    ...config.connections.map((c) => c.type),
    ...widgets.map((w) => w.id),
    config.theme,
  ].map((v) => v.toLowerCase()))
  const context: RedactionContext = {
    secrets,
    hosts,
    names: names.filter((n) => !reserved.has(n.trim().toLowerCase())),
    machineNames: system.machineNames,
    home: system.home,
    username: system.username,
  }
  return redact(renderReport(facts), context)
}

async function readSystemFactsUnlessGiven(given: Partial<SystemFacts> | undefined): Promise<SystemFacts> {
  const base = given && isComplete(given) ? given : { ...(await readSystemFacts()), ...given }
  return base as SystemFacts
}

function isComplete(given: Partial<SystemFacts>): given is SystemFacts {
  return ['node', 'macos', 'darwin', 'arch', 'home', 'username', 'machineNames', 'install', 'dev'].every((k) => k in given)
}
