import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

/** Owner read/write only: the file holds the hashes of the device tokens. */
const MODE = 0o600

/** `lastSeen` is written at most this often per device, so a busy iPad does not churn the disk. */
const TOUCH_INTERVAL_MS = 60_000

export const ViewportSchema = z.object({
  width: z.number().int().min(1).max(10000),
  height: z.number().int().min(1).max(10000),
})

const DeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  pairedAt: z.string(),
  lastSeen: z.string().nullable(),
  viewport: ViewportSchema,
  screenId: z.string().nullable(),
})

const FileSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  devices: z.array(DeviceSchema),
})

export type Viewport = z.infer<typeof ViewportSchema>
export type Device = {
  id: string
  name: string
  tokenHash: string
  pairedAt: string
  lastSeen: string | null
  viewport: { width: number; height: number }
  screenId: string | null
}
export type PublicDevice = Omit<Device, 'tokenHash'>

type State = { enabled: boolean; devices: Device[] }

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function toPublic(device: Device): PublicDevice {
  const { tokenHash: _omit, ...rest } = device
  return { ...rest, viewport: { ...rest.viewport } }
}

/**
 * The paired devices, in `<dataDir>/devices.json`.
 *
 * The state lives in memory once loaded, so `findByToken` (called on every remote request) never
 * touches the disk. Every mutation builds the next state, writes it atomically, and only then
 * replaces the in-memory one: a failed write leaves memory and disk agreeing.
 */
export class DeviceStore {
  private state: State = { enabled: false, devices: [] }
  private readonly listeners = new Set<(devices: PublicDevice[]) => void>()

  // Serializes mutations, the same pattern as `secrets/file.ts`: two overlapping mutations would
  // otherwise both start from the same state and the second write would drop the first's change.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Reads the file. Missing means disabled and empty; corrupt is moved aside and starts empty. */
  async load(): Promise<void> {
    return this.enqueue(async () => {
      let raw: string
      try {
        raw = await readFile(this.filePath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.state = { enabled: false, devices: [] }
          return
        }
        throw err
      }
      let parsed: z.infer<typeof FileSchema> | null = null
      try {
        const result = FileSchema.safeParse(JSON.parse(raw))
        if (result.success) parsed = result.data
      } catch {
        parsed = null
      }
      if (!parsed) {
        // Kept rather than deleted, so a hand-edit gone wrong can still be recovered.
        await rename(this.filePath, `${this.filePath}.corrupt`)
        this.state = { enabled: false, devices: [] }
        return
      }
      this.state = { enabled: parsed.enabled, devices: parsed.devices }
    })
  }

  get enabled(): boolean {
    return this.state.enabled
  }

  async setEnabled(on: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (this.state.enabled === on) return
      await this.commit({ ...this.state, enabled: on })
    })
  }

  list(): PublicDevice[] {
    return this.state.devices.map(toPublic)
  }

  /** Pairs a device. The token is returned once, here, and only its hash is ever stored. */
  async create(
    name: string,
    viewport: Viewport,
    screenId: string | null,
  ): Promise<{ device: PublicDevice; token: string }> {
    return this.enqueue(async () => {
      const token = randomBytes(32).toString('base64url')
      const device: Device = {
        id: randomUUID(),
        name,
        tokenHash: hashToken(token),
        pairedAt: this.now().toISOString(),
        lastSeen: null,
        viewport: { width: viewport.width, height: viewport.height },
        screenId,
      }
      await this.commit({ ...this.state, devices: [...this.state.devices, device] })
      return { device: toPublic(device), token }
    })
  }

  /**
   * The device a token belongs to, or null. The candidate is hashed and compared against every
   * stored hash in constant time, with no early exit, so timing reveals neither the match nor
   * which device it was.
   */
  findByToken(token: string): PublicDevice | null {
    const candidate = Buffer.from(hashToken(token), 'utf8')
    let found: Device | null = null
    for (const device of this.state.devices) {
      const stored = Buffer.from(device.tokenHash, 'utf8')
      // The schema pins every stored hash to 64 hex characters, as is the candidate's, so the
      // lengths always match; the guard only keeps timingSafeEqual from throwing.
      const same = stored.length === candidate.length && timingSafeEqual(stored, candidate)
      if (same && !found) found = device
    }
    return found ? toPublic(found) : null
  }

  async update(id: string, patch: { name?: string; screenId?: string | null }): Promise<PublicDevice | null> {
    return this.enqueue(async () => {
      const index = this.state.devices.findIndex((d) => d.id === id)
      if (index < 0) return null
      const next: Device = { ...this.state.devices[index] }
      if (patch.name !== undefined) next.name = patch.name
      if (patch.screenId !== undefined) next.screenId = patch.screenId
      const devices = [...this.state.devices]
      devices[index] = next
      await this.commit({ ...this.state, devices })
      return toPublic(next)
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const devices = this.state.devices.filter((d) => d.id !== id)
      if (devices.length === this.state.devices.length) return false
      await this.commit({ ...this.state, devices })
      return true
    })
  }

  async removeAll(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state.devices.length === 0) return
      await this.commit({ ...this.state, devices: [] })
    })
  }

  /** Records that a device was seen, writing only when the stored `lastSeen` is a minute old. */
  async touch(id: string): Promise<void> {
    return this.enqueue(async () => {
      const index = this.state.devices.findIndex((d) => d.id === id)
      if (index < 0) return
      const now = this.now()
      const last = this.state.devices[index].lastSeen
      if (last !== null && now.getTime() - Date.parse(last) < TOUCH_INTERVAL_MS) return
      const devices = [...this.state.devices]
      devices[index] = { ...devices[index], lastSeen: now.toISOString() }
      await this.commit({ ...this.state, devices })
    })
  }

  /** Called with the public device list after every successful write. Returns an unsubscribe. */
  onChange(cb: (devices: PublicDevice[]) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private async commit(next: State): Promise<void> {
    await this.write(next)
    this.state = next
    const devices = this.list()
    for (const cb of this.listeners) {
      try {
        cb(devices)
      } catch {
        // A listener's failure must not turn a successful write into a failed mutation.
      }
    }
  }

  private async write(state: State): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    const body = { version: 1, enabled: state.enabled, devices: state.devices }
    // The mode is given at creation *and* forced afterwards: `writeFile` only applies `mode`
    // when it creates the file, so a leftover temporary from a crashed run would keep its own.
    await writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: MODE })
    await chmod(tmp, MODE)
    await rename(tmp, this.filePath)
  }
}
