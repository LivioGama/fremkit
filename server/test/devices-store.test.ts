import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore } from '../src/devices/store.js'

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'fremkit-devices-')), 'devices.json')
}

const viewport = { width: 1180, height: 820 }

describe('DeviceStore', () => {
  it('starts disabled and empty when the file is missing', async () => {
    const store = new DeviceStore(await tempFile())
    await store.load()
    expect(store.enabled).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('round-trips a created device through a reload', async () => {
    const file = await tempFile()
    const store = new DeviceStore(file, () => new Date('2026-10-18T10:00:00.000Z'))
    await store.load()
    await store.setEnabled(true)
    const { device, token } = await store.create('Kitchen iPad', viewport, 'screen-1')
    expect(device).toEqual({
      id: expect.any(String),
      name: 'Kitchen iPad',
      pairedAt: '2026-10-18T10:00:00.000Z',
      lastSeen: null,
      viewport,
      screenId: 'screen-1',
    })
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)

    const again = new DeviceStore(file)
    await again.load()
    expect(again.enabled).toBe(true)
    expect(again.list()).toEqual([device])
    expect(again.findByToken(token)).toEqual(device)
  })

  it('writes the file with mode 0600 and stores only the token hash', async () => {
    const file = await tempFile()
    const store = new DeviceStore(file)
    await store.load()
    const { token } = await store.create('iPad', viewport, null)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain(token)
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(1)
    expect(parsed.devices[0].tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never exposes tokenHash from list()', async () => {
    const store = new DeviceStore(await tempFile())
    await store.load()
    await store.create('A', viewport, null)
    await store.create('B', viewport, null)
    for (const d of store.list()) expect(d).not.toHaveProperty('tokenHash')
  })

  it('finds a device by its token and nothing by any other', async () => {
    const store = new DeviceStore(await tempFile())
    await store.load()
    const a = await store.create('A', viewport, null)
    const b = await store.create('B', viewport, null)
    expect(store.findByToken(a.token)?.id).toBe(a.device.id)
    expect(store.findByToken(b.token)?.id).toBe(b.device.id)
    expect(store.findByToken(a.token + 'x')).toBeNull()
    expect(store.findByToken('')).toBeNull()
    expect(store.findByToken('not-a-token')).toBeNull()
    expect(store.findByToken(a.token)).not.toHaveProperty('tokenHash')
  })

  it('writes lastSeen at most once a minute', async () => {
    const file = await tempFile()
    let t = Date.parse('2026-10-18T10:00:00.000Z')
    const store = new DeviceStore(file, () => new Date(t))
    await store.load()
    const { device } = await store.create('iPad', viewport, null)
    let writes = 0
    store.onChange(() => writes++)

    await store.touch(device.id)
    expect(writes).toBe(1)
    expect(store.list()[0].lastSeen).toBe('2026-10-18T10:00:00.000Z')

    t += 59_000
    await store.touch(device.id)
    expect(writes).toBe(1)
    expect(store.list()[0].lastSeen).toBe('2026-10-18T10:00:00.000Z')

    t += 2_000
    await store.touch(device.id)
    expect(writes).toBe(2)
    expect(store.list()[0].lastSeen).toBe('2026-10-18T10:01:01.000Z')
    expect(JSON.parse(await readFile(file, 'utf8')).devices[0].lastSeen).toBe('2026-10-18T10:01:01.000Z')

    await store.touch('unknown')
    expect(writes).toBe(2)
  })

  it('writes lastSeen again when the clock stepped back behind it', async () => {
    const file = await tempFile()
    let t = Date.parse('2026-10-18T10:00:00.000Z')
    const store = new DeviceStore(file, () => new Date(t))
    await store.load()
    const { device } = await store.create('iPad', viewport, null)
    await store.touch(device.id)
    let writes = 0
    store.onChange(() => writes++)

    // An hour back: the stored lastSeen is now in the future.
    t -= 3_600_000
    await store.touch(device.id)
    expect(writes).toBe(1)
    expect(store.list()[0].lastSeen).toBe('2026-10-18T09:00:00.000Z')
    // And from there on, the minute counts again from the corrected time.
    t += 30_000
    await store.touch(device.id)
    expect(writes).toBe(1)
  })

  it('moves a corrupt file aside and starts empty', async () => {
    const file = await tempFile()
    await writeFile(file, '{ not json')
    const store = new DeviceStore(file)
    await store.load()
    expect(store.enabled).toBe(false)
    expect(store.list()).toEqual([])
    expect(await readFile(`${file}.corrupt`, 'utf8')).toBe('{ not json')
  })

  it('treats a file that fails the schema as corrupt', async () => {
    const file = await tempFile()
    const bad = JSON.stringify({ version: 1, enabled: true, devices: [{ id: 'x' }] })
    await writeFile(file, bad)
    const store = new DeviceStore(file)
    await store.load()
    expect(store.list()).toEqual([])
    expect(await readFile(`${file}.corrupt`, 'utf8')).toBe(bad)
  })

  it('updates, removes and clears devices', async () => {
    const file = await tempFile()
    const store = new DeviceStore(file)
    await store.load()
    const a = await store.create('A', viewport, null)
    const b = await store.create('B', viewport, null)

    expect(await store.update('unknown', { name: 'X' })).toBeNull()
    const updated = await store.update(a.device.id, { name: 'Hall', screenId: 'screen-2' })
    expect(updated).toMatchObject({ id: a.device.id, name: 'Hall', screenId: 'screen-2' })
    expect(updated).not.toHaveProperty('tokenHash')
    expect(await store.update(a.device.id, { screenId: null })).toMatchObject({ name: 'Hall', screenId: null })

    expect(await store.remove('unknown')).toBe(false)
    expect(await store.remove(b.device.id)).toBe(true)
    expect(store.findByToken(b.token)).toBeNull()
    expect(store.list().map((d) => d.id)).toEqual([a.device.id])

    await store.removeAll()
    expect(store.list()).toEqual([])
    const again = new DeviceStore(file)
    await again.load()
    expect(again.list()).toEqual([])
  })

  it('serializes concurrent mutations', async () => {
    const file = await tempFile()
    const store = new DeviceStore(file)
    await store.load()
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.create(`D${n}`, viewport, null)))
    const again = new DeviceStore(file)
    await again.load()
    expect(again.list().map((d) => d.name).sort()).toEqual(['D1', 'D2', 'D3', 'D4', 'D5'])
  })

  it('notifies listeners after a write, with public devices, until unsubscribed', async () => {
    const store = new DeviceStore(await tempFile())
    await store.load()
    const seen: unknown[][] = []
    const off = store.onChange((devices) => seen.push(devices))
    await store.create('A', viewport, null)
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).not.toHaveProperty('tokenHash')
    off()
    await store.create('B', viewport, null)
    expect(seen).toHaveLength(1)
  })
})
