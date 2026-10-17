import { describe, expect, it, vi, beforeAll, afterAll } from 'vite-plus/test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMMANDS,
  createNowPlayingProvider,
  parseNowPlaying,
  resolveNowPlayingBinary,
} from '../src/providers/now-playing.js'

let fixture: string
beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'fremkit-now-playing-'))
})
afterAll(async () => {
  await rm(fixture, { recursive: true, force: true })
})

describe('parseNowPlaying', () => {
  it('keeps the fields the binary prints, whole numbers and all', () => {
    expect(parseNowPlaying(JSON.stringify({
      available: true,
      state: 'playing',
      title: ' A song ',
      artist: 'An artist',
      album: 'An album',
      app: 'Music',
      artwork: 'https://example.test/art.jpg',
      durationMs: 201234.7,
      positionMs: '1234.4',
    }))).toEqual({
      available: true,
      state: 'playing',
      title: 'A song',
      artist: 'An artist',
      album: 'An album',
      app: 'Music',
      artwork: 'https://example.test/art.jpg',
      durationMs: 201235,
      positionMs: 1234,
    })
  })

  it('treats an empty, malformed or unknown answer as nothing playing', () => {
    expect(parseNowPlaying('not json')).toEqual({ available: false })
    expect(parseNowPlaying('{}')).toEqual({ available: false })
    expect(parseNowPlaying('null')).toEqual({ available: false })
    expect(parseNowPlaying(JSON.stringify({ state: 'unknown', title: 42 }))).toEqual({ available: false })
  })

  it('keeps the error a binary without MediaRemote reports', () => {
    expect(parseNowPlaying(JSON.stringify({ available: false, error: 'mediaremote' }))).toMatchObject({
      available: false, error: 'mediaremote',
    })
  })

  it('caps the text and the artwork a player can put in a snapshot', () => {
    const long = parseNowPlaying(JSON.stringify({
      available: true,
      title: 'x'.repeat(2000),
      artwork: `data:image/jpeg;base64,${'A'.repeat(200_000)}`,
    }))
    expect(long.title).toHaveLength(512)
    expect(long.artwork).toBeUndefined()
  })

  it('accepts a session whose only metadata is a state', () => {
    expect(parseNowPlaying(JSON.stringify({ available: true, state: 'paused' }))).toMatchObject({
      available: true, state: 'paused',
    })
  })
})

describe('resolveNowPlayingBinary', () => {
  it('takes an absolute path to an executable file, and nothing else', async () => {
    const script = join(fixture, 'now-playing.sh')
    await writeFile(script, '#!/bin/sh\n', { mode: 0o755 })
    expect(await resolveNowPlayingBinary({ FREMKIT_NOWPLAYING: script, FREMKIT_ROOT: fixture })).toBe(script)

    // Neither answer may be a binary: a relative or missing path falls through to the checkout
    // candidates, and the fixture tree has none.
    expect(await resolveNowPlayingBinary({ FREMKIT_NOWPLAYING: 'now-playing.sh', FREMKIT_ROOT: fixture }))
      .toBeNull()
    expect(await resolveNowPlayingBinary({ FREMKIT_NOWPLAYING: join(fixture, 'nope'), FREMKIT_ROOT: fixture }))
      .toBeNull()

    const plain = join(fixture, 'plain.txt')
    await writeFile(plain, 'x', { mode: 0o644 })
    expect(await resolveNowPlayingBinary({ FREMKIT_NOWPLAYING: plain, FREMKIT_ROOT: fixture })).not.toBe(plain)
    await chmod(plain, 0o755)
  })
})

describe('now-playing provider', () => {
  it('polls the binary and exposes the documented channel', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      available: true, title: 'Song', artist: 'Artist', app: 'Spotify', state: 'paused',
    }))
    const provider = createNowPlayingProvider({}, run)

    expect(provider.channel).toBe('now-playing')
    expect(provider.intervalMs).toBe(2000)
    await expect(provider.poll!()).resolves.toMatchObject({
      available: true, title: 'Song', artist: 'Artist', app: 'Spotify', state: 'paused',
    })
    expect(run).toHaveBeenCalledWith(['snapshot'])
  })

  it('says so instead of throwing when this machine has no binary', async () => {
    const provider = createNowPlayingProvider({ FREMKIT_ROOT: fixture })
    await expect(provider.poll!()).resolves.toEqual({ available: false, error: 'unavailable' })
    await expect(provider.commands!.playPause({}, { loopback: true })).resolves.toEqual({
      ok: false, error: 'unavailable',
    })
  })

  it('gates every playback command to loopback clients', async () => {
    const run = vi.fn().mockResolvedValue('')
    const provider = createNowPlayingProvider({}, run)

    for (const name of COMMANDS) {
      await expect(provider.commands![name]({}, { loopback: false })).resolves.toMatchObject({ ok: false })
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('names the two track buttons as the binary does', async () => {
    const run = vi.fn().mockResolvedValue('')
    const provider = createNowPlayingProvider({}, run)
    await expect(provider.commands!.previous({}, { loopback: true })).resolves.toEqual({ ok: true })
    await expect(provider.commands!.next({}, { loopback: true })).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenNthCalledWith(1, ['command', 'previous'])
    expect(run).toHaveBeenNthCalledWith(2, ['command', 'next'])
  })

  it('asks for pause or play by name, never for a toggle', async () => {
    const playing = vi.fn().mockResolvedValueOnce(JSON.stringify({ available: true, state: 'playing' }))
    await expect(createNowPlayingProvider({}, playing).commands!.playPause({}, { loopback: true }))
      .resolves.toEqual({ ok: true })
    expect(playing).toHaveBeenNthCalledWith(1, ['snapshot'])
    expect(playing).toHaveBeenNthCalledWith(2, ['command', 'pause'])

    const paused = vi.fn().mockResolvedValueOnce(JSON.stringify({ available: true, state: 'paused' }))
    await expect(createNowPlayingProvider({}, paused).commands!.playPause({}, { loopback: true }))
      .resolves.toEqual({ ok: true })
    expect(paused).toHaveBeenNthCalledWith(2, ['command', 'play'])
  })

  it('lets a failed command reach the caller', async () => {
    const run = vi.fn().mockRejectedValue(new Error('no media session'))
    const provider = createNowPlayingProvider({}, run)
    await expect(provider.commands!.next({}, { loopback: true })).rejects.toThrow('no media session')
  })
})
