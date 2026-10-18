/**
 * Device pairing, put together: the remote switch and its TLS listener, the pairing code, the
 * paired devices and the screen each one shows, and what the hub lets each of them hear.
 *
 * The parts are built and tested on their own (`store.ts`, `codes.ts`, `certificate.ts`,
 * `listener.ts`, `gate.ts`, `channels.ts`); this is the one place that knows how they meet.
 */

import type { FastifyInstance } from 'fastify'
import type { Config } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import { grantedCatalog } from '../marketplace/consent.js'
import { execFileAsync, type Exec } from '../secrets/keychain.js'
import type { SecretStore } from '../secrets/types.js'
import type { WidgetCatalog } from '../widgets/catalog.js'
import type { Hub } from '../ws/hub.js'
import { fingerprintWords } from './fingerprint.js'
import { advertise as bonjourAdvertise, type Advertisement, type Advertiser } from './bonjour.js'
import { ensureKey, issueCertificate, readKey, resetKey, spkiHash } from './certificate.js'
import { screenChannels, type ChannelManifest, type ScreenChannels } from './channels.js'
import type { PairingCodes } from './codes.js'
import { lanAddresses as readLanAddresses, computerName, localHostName, preferredAddress } from './host.js'
import { REMOTE_PORT, RemoteListener } from './listener.js'
import type { DeviceStore, PublicDevice, Viewport } from './store.js'

/** How often the LAN addresses are re-read while listening, to follow a DHCP change. */
const ADDRESS_CHECK_MS = 30_000

export type DeviceStatus = {
  enabled: boolean
  listening: boolean
  error: 'portInUse' | null
  guessing: boolean
  /** `<LocalHostName>.local`, or null when the Mac has none. */
  host: string | null
  addresses: string[]
  port: number
  /** Base64url SHA-256 of the key's SPKI: what a device pins. Never the key itself. */
  keyHash: string | null
  /** Four words from the key's hash, for a person to compare with the device's screen. */
  fingerprint: string[] | null
  devices: PublicDevice[]
}

export type PairingOffer = { code: string; expiresAt: number; url: string }

/** What the page of a device needs to apply its screen's brightness; null when the screen has none. */
export type DeviceBrightness = { target: number | null; seq: number }

export type DeviceInfo = { id: string; name: string; screenId: string | null; brightness: DeviceBrightness | null }

export type PairResult =
  | { token: string; device: PublicDevice }
  | { error: 'wrong' | 'expired' | 'limited' }

export interface DeviceServiceOptions {
  /** The brightness decided for a screen, injected so this module does not import brightness. */
  brightnessOf?: (screenId: string) => DeviceBrightness | null
  app: FastifyInstance
  store: DeviceStore
  codes: PairingCodes
  secrets: SecretStore
  config: ConfigStore
  hub: Hub
  catalog: WidgetCatalog
  listenerPort?: number
  /** Runs `scutil` and `openssl`; tests swap the first for a fixed name. */
  exec?: Exec
  /** Bonjour; tests pass `noAdvertise` so `dns-sd` never runs there. */
  advertise?: Advertiser
  lanAddresses?: () => string[]
  /** Which of the addresses the QR code carries; the default asks the Mac's default route. */
  preferredAddress?: (addresses: string[]) => Promise<string | null>
}

/** Whether a device screen was made for this viewport, in either orientation. */
function fits(screen: Config['screens'][number], viewport: Viewport): boolean {
  const v = screen.display.viewport
  if (!v) return false
  return (v.width === viewport.width && v.height === viewport.height)
    || (v.width === viewport.height && v.height === viewport.width)
}

function isDeviceScreen(config: Config, screenId: string): boolean {
  return config.screens.some((s) => s.id === screenId && s.kind === 'device')
}

export class DeviceService {
  private readonly app: FastifyInstance
  private readonly store: DeviceStore
  private readonly codes: PairingCodes
  private readonly secrets: SecretStore
  private readonly config: ConfigStore
  private readonly hub: Hub
  private readonly catalog: WidgetCatalog
  private readonly exec: Exec
  private readonly advertiser: Advertiser
  private readonly readAddresses: () => string[]
  private readonly pickAddress: (addresses: string[]) => Promise<string | null>
  private readonly listener: RemoteListener

  /**
   * Every start, stop, certificate swap and address check goes through this one chain, so they
   * never overlap: a stop asked for during a start waits for the start and then stops.
   */
  private chain: Promise<unknown> = Promise.resolve()
  private error: 'portInUse' | null = null
  private hostName: string | null = null
  /** The addresses the current certificate was issued for. */
  private certAddresses: string[] = []
  private hosts = new Set<string>()
  private keyHash: string | null = null
  private keyHashKnown = false
  private bonjour: Advertisement | null = null
  /** The name and TXT address `bonjour` was started with, to restart it when the address moves. */
  private bonjourName = 'Fremkit'
  private bonjourAddress: string | null = null
  private timer: NodeJS.Timeout | null = null
  /** The granted catalogue, as the policy reads it; dropped when the config or catalogue moves. */
  private manifests: Map<string, ChannelManifest> | null = null
  private readonly brightnessOf: (screenId: string) => DeviceBrightness | null

  constructor(opts: DeviceServiceOptions) {
    this.app = opts.app
    this.store = opts.store
    this.codes = opts.codes
    this.secrets = opts.secrets
    this.config = opts.config
    this.hub = opts.hub
    this.brightnessOf = opts.brightnessOf ?? (() => null)
    this.catalog = opts.catalog
    this.exec = opts.exec ?? execFileAsync
    this.advertiser = opts.advertise ?? bonjourAdvertise
    this.readAddresses = opts.lanAddresses ?? readLanAddresses
    this.pickAddress = opts.preferredAddress ?? ((addresses) => preferredAddress(addresses, this.exec))
    this.listener = new RemoteListener(opts.app, opts.listenerPort ?? REMOTE_PORT)
  }

  /** Wires the hub and the change listeners, then starts the listener if the switch was left on. */
  async init(): Promise<void> {
    this.hub.setPolicy((deviceId) => this.policyFor(deviceId))
    this.hub.setDevicePayload((deviceId) => this.me(deviceId))
    this.config.onChange((cfg) => this.onConfigChange(cfg))
    this.catalog.onScan(() => {
      this.manifests = null
      this.refreshAll()
    })
    if (!this.store.enabled) return
    try {
      await this.setEnabled(true)
    } catch (err) {
      // A failed start must not keep the dashboard from booting; the switch stays on, so the next
      // start tries again, and the admin shows it is not listening.
      this.app.log.warn({ err: (err as Error).message }, 'could not start the remote listener')
    }
  }

  get listening(): boolean {
    return this.listener.running
  }

  setEnabled(on: boolean): Promise<{ enabled: boolean; error?: 'portInUse' }> {
    return this.serialize(() => (on ? this.start() : this.stop()))
  }

  /** Stops everything for good: the app is closing. */
  close(): Promise<void> {
    return this.serialize(async () => { await this.halt() })
  }

  status(): DeviceStatus {
    return {
      enabled: this.store.enabled,
      listening: this.listener.running,
      error: this.error,
      guessing: this.codes.guessing(),
      host: this.hostName === null ? null : `${this.hostName}.local`,
      addresses: this.readAddresses(),
      port: this.listener.port,
      keyHash: this.keyHash,
      fingerprint: this.keyHash === null ? null : fingerprintWords(this.keyHash),
      devices: this.store.list(),
    }
  }

  /**
   * Reads the key's hash for `status()` without creating a key. Separate and lazy so that building
   * the app never touches the keychain: only the admin asking for the status does.
   */
  async loadKeyHash(): Promise<void> {
    if (this.keyHashKnown) return
    const pem = await readKey(this.secrets)
    this.keyHash = pem ? spkiHash(pem) : null
    this.keyHashKnown = true
  }

  /** A fresh code and the QR payload carrying it. Only while listening: the caller checks. */
  async pairingCode(): Promise<PairingOffer> {
    const key = await ensureKey(this.secrets, { exec: this.exec })
    this.keyHash = spkiHash(key)
    this.keyHashKnown = true
    const { code, expiresAt } = this.codes.issue()
    const params: string[] = []
    if (this.hostName !== null) params.push(`h=${encodeURIComponent(`${this.hostName}.local`)}`)
    const address = await this.pickAddress(this.readAddresses())
    if (address !== null) params.push(`a=${encodeURIComponent(address)}`)
    params.push(`p=${this.listener.port}`, `c=${code}`, `k=${this.keyHash}`)
    return { code, expiresAt, url: `fremkit://pair?${params.join('&')}` }
  }

  /**
   * Pairs a device with the live code. It is attached to the one device screen made for its
   * viewport; none, or more than one, leaves it unattached for the user to choose.
   */
  async pair(code: string, name: string, viewport: Viewport): Promise<PairResult> {
    const result = this.codes.consume(code)
    if (result !== 'ok') return { error: result }
    const matches = this.config.get().screens.filter((s) => s.kind === 'device' && fits(s, viewport))
    const screenId = matches.length === 1 ? matches[0].id : null
    const { device, token } = await this.store.create(name, viewport, screenId)
    return { token, device }
  }

  /** Puts a device on a device screen, or on none. Refuses any other screen. */
  async attach(id: string, screenId: string | null): Promise<PublicDevice | null | 'screenNotDevice'> {
    if (screenId !== null && !isDeviceScreen(this.config.get(), screenId)) return 'screenNotDevice'
    const device = await this.store.update(id, { screenId })
    if (device) this.hub.refreshDevice(id)
    return device
  }

  async rename(id: string, name: string): Promise<PublicDevice | null> {
    const device = await this.store.update(id, { name })
    if (device) this.hub.refreshDevice(id)
    return device
  }

  async revoke(id: string): Promise<boolean> {
    const removed = await this.store.remove(id)
    // Closed whatever the store said: a socket of a device already gone has no business open.
    this.hub.closeDevice(id)
    return removed
  }

  async revokeAll(): Promise<void> {
    const ids = this.store.list().map((d) => d.id)
    await this.store.removeAll()
    for (const id of ids) this.hub.closeDevice(id)
  }

  /**
   * A new key, so a new pin, and every device has to pair again: their records and tokens go, and
   * so do their sockets. A live code carried the old pin in its QR, so it goes too; a running
   * listener is switched to a certificate from the new key.
   */
  resetCertificate(): Promise<void> {
    return this.serialize(async () => {
      const key = await resetKey(this.secrets, { exec: this.exec })
      this.keyHash = spkiHash(key)
      this.keyHashKnown = true
      this.codes.clear()
      // `revokeAll`'s body, inline: it is not serialized itself, and this already is.
      const ids = this.store.list().map((d) => d.id)
      await this.store.removeAll()
      for (const id of ids) this.hub.closeDevice(id)
      this.hub.closeRemote()
      if (this.listener.running) {
        const cert = await issueCertificate(key, { host: this.dnsName(), addresses: this.certAddresses }, { exec: this.exec })
        this.listener.setCertificate(key, cert)
        // A keep-alive connection would otherwise go on over the old key, which nothing pins now.
        this.listener.dropConnections()
      }
    })
  }

  me(deviceId: string): DeviceInfo | null {
    const device = this.store.list().find((d) => d.id === deviceId)
    if (!device) return null
    const brightness = device.screenId === null ? null : this.brightnessOf(device.screenId)
    return { id: device.id, name: device.name, screenId: device.screenId, brightness }
  }

  /** The screen a device is bound to, only while it is a device screen: where its brightness goes. */
  deviceScreenOf(deviceId: string): string | null {
    const screenId = this.store.list().find((d) => d.id === deviceId)?.screenId ?? null
    return screenId !== null && isDeviceScreen(this.config.get(), screenId) ? screenId : null
  }

  /** Re-sends the `device` payload to every device bound to one of these screens. */
  screensChanged(screenIds: string[]): void {
    for (const d of this.store.list()) {
      if (d.screenId !== null && screenIds.includes(d.screenId)) this.hub.refreshDevice(d.id)
    }
  }

  // --- internals -------------------------------------------------------------------------------

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run, run)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  private dnsName(): string | null {
    return this.hostName === null ? null : `${this.hostName}.local`
  }

  private async start(): Promise<{ enabled: boolean; error?: 'portInUse' }> {
    if (this.listener.running) {
      await this.store.setEnabled(true)
      return { enabled: true }
    }
    const key = await ensureKey(this.secrets, { exec: this.exec })
    this.keyHash = spkiHash(key)
    this.keyHashKnown = true
    this.hostName = await localHostName(this.exec)
    this.certAddresses = this.readAddresses()
    const cert = await issueCertificate(key, { host: this.dnsName(), addresses: this.certAddresses }, { exec: this.exec })
    try {
      await this.listener.start(key, cert)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      this.error = 'portInUse'
      await this.store.setEnabled(false)
      return { enabled: false, error: 'portInUse' }
    }
    this.error = null
    this.updateHosts()
    this.bonjourName = await computerName(this.exec)
    this.bonjourAddress = await this.pickAddress(this.certAddresses)
    this.bonjour = this.advertiser(this.listener.port, this.bonjourName, this.bonjourAddress)
    this.timer = setInterval(() => { void this.checkAddresses() }, ADDRESS_CHECK_MS)
    this.timer.unref()
    await this.store.setEnabled(true)
    return { enabled: true }
  }

  private async stop(): Promise<{ enabled: boolean }> {
    await this.halt()
    this.codes.clear()
    this.error = null
    await this.store.setEnabled(false)
    return { enabled: false }
  }

  /** Stops listening and advertising and drops every paired socket, without touching the switch. */
  private async halt(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.bonjour?.stop()
    this.bonjour = null
    this.hosts = new Set()
    this.app.pairing.setRemoteHosts(() => this.hosts)
    await this.listener.stop()
    this.hub.closeRemote()
  }

  /** The `host:port` authorities the gate lets in, lowercased as it compares them. */
  private updateHosts(): void {
    const port = this.listener.port
    const names = [
      ...(this.hostName !== null ? [`${this.hostName}.local:${port}`] : []),
      ...this.certAddresses.map((a) => `${a}:${port}`),
    ]
    this.hosts = new Set(names.map((n) => n.toLowerCase()))
    this.app.pairing.setRemoteHosts(() => this.hosts)
  }

  /**
   * Follows the Mac to a new address: re-issues the certificate from the same key (so the pin
   * holds), lets the new authority through the gate, and advertises the new address in the
   * Bonjour TXT record. Nothing happens when nothing changed.
   */
  private checkAddresses(): Promise<void> {
    return this.serialize(async () => {
      if (!this.listener.running) return
      const addresses = this.readAddresses()
      const hostName = await localHostName(this.exec)
      if (addresses.join(',') === this.certAddresses.join(',') && hostName === this.hostName) return
      const key = await ensureKey(this.secrets, { exec: this.exec })
      const cert = await issueCertificate(key, { host: hostName === null ? null : `${hostName}.local`, addresses }, { exec: this.exec })
      if (!this.listener.running) return
      this.listener.setCertificate(key, cert)
      this.hostName = hostName
      this.certAddresses = addresses
      this.updateHosts()
      // The advertisement carries the address too (TXT `a=`): announce the new one.
      const address = await this.pickAddress(addresses)
      if (!this.listener.running || this.bonjour === null || address === this.bonjourAddress) return
      this.bonjour.stop()
      this.bonjourAddress = address
      this.bonjour = this.advertiser(this.listener.port, this.bonjourName, address)
    }).catch((err: unknown) => {
      this.app.log.warn({ err: (err as Error).message }, 'could not follow a change of address')
    })
  }

  private grantedManifests(): Map<string, ChannelManifest> {
    this.manifests ??= grantedCatalog(this.catalog, this.config.get())
    return this.manifests
  }

  /** What a device may hear: its screen's channels, or nothing beyond the host's own. */
  private policyFor(deviceId: string): ScreenChannels | null {
    const screenId = this.me(deviceId)?.screenId ?? null
    if (screenId === null) return null
    const config = this.config.get()
    // A screen that stopped being a device screen grants nothing, even before the store catches up.
    if (!isDeviceScreen(config, screenId)) return null
    return screenChannels(config, screenId, this.grantedManifests())
  }

  private refreshAll(): void {
    for (const device of this.store.list()) this.hub.refreshDevice(device.id)
  }

  /**
   * Runs inside the config store's queue: it must not save the config, and does not wait for the
   * devices file it writes. Policies are narrowed at once — a screen gone or turned into another
   * kind already grants nothing — and the orphans are refreshed again once their record says so.
   */
  private onConfigChange(cfg: Config): void {
    this.manifests = null
    for (const device of this.store.list()) {
      if (device.screenId === null || isDeviceScreen(cfg, device.screenId)) continue
      // Conditional, inside the store's queue: an attach to another screen queued before this
      // write runs must not be undone by it.
      void this.store.detach(device.id, device.screenId)
        .then((changed) => { if (changed) this.hub.refreshDevice(device.id) })
        .catch((err: unknown) => {
          this.app.log.warn({ err: (err as Error).message }, 'could not detach a device from its screen')
        })
    }
    this.refreshAll()
  }
}
