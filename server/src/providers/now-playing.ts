import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { shippedPaths } from '../paths.js'
import { tr } from '../i18n.js'
import type { CommandContext, Provider } from './types.js'

/** The executable built from `native/Sources/FremkitNowPlaying` by `scripts/build-helper.sh`. */
export const NOW_PLAYING_BINARY = 'fremkit-nowplaying'

/**
 * The transport commands a widget may send. `playPause` is the widget's name for the button;
 * the binary is asked for `play` or `pause` by name, after the provider has read the state —
 * MediaRemote's TogglePlayPause (2) is ignored by QuickTime Player on macOS 27, and Play (0)
 * and Pause (1) are not. NextTrack is 4 and PreviousTrack 5, which is not the order the two
 * track buttons appear in.
 */
export const COMMANDS = ['previous', 'playPause', 'next'] as const
export type NowPlayingCommand = (typeof COMMANDS)[number]

/** What the binary accepts for each widget command, when it is not decided by the state. */
const FIXED_COMMANDS: Record<'previous' | 'next', string> = { previous: 'previous', next: 'next' }

/** The snapshot printed by `fremkit-nowplaying snapshot`. */
export interface NowPlayingSnapshot {
  available: boolean
  state?: 'playing' | 'paused' | 'stopped'
  title?: string
  artist?: string
  album?: string
  artwork?: string
  /** The app that owns the session, as `NSRunningApplication.localizedName` says it. */
  app?: string
  durationMs?: number
  positionMs?: number
  /** Set when the binary could not reach MediaRemote at all; `available` is false with it. */
  error?: string
}

/** Runs the binary with an argument list. Exported so a test can answer without one. */
export type NowPlayingRun = (args: string[]) => Promise<string>

export function binaryRun(path: string): NowPlayingRun {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(path, args, { timeout: 3000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message))
        else resolve(stdout.trim())
      })
    })
}

async function executable(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Where the binary is: the path the helper named (`FREMKIT_NOWPLAYING`, absolute, as it does for
 * the disk scanner), or the two places a checkout builds it. Anything else — unset, relative,
 * missing, not executable — means no media player on this machine, and the widget says so.
 */
export async function resolveNowPlayingBinary(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const candidates: string[] = []
  const named = env.FREMKIT_NOWPLAYING
  if (named && isAbsolute(named)) candidates.push(named)
  const root = shippedPaths(env).root
  candidates.push(join(root, 'native/.build/swiftc', NOW_PLAYING_BINARY))
  candidates.push(join(root, 'native/dist/Fremkit Helper.app/Contents/MacOS', NOW_PLAYING_BINARY))
  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate
  }
  return null
}

const number = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.round(n) : undefined
}

/** Longest text a snapshot carries from the player: a title, an artist, an album, an app name. */
const MAX_TEXT = 512

/** Longest artwork the snapshot carries. The helper sends a 96 px JPEG, a few kilobytes. */
const MAX_ARTWORK = 96 * 1024

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  // A player is not trusted to keep its metadata short: the snapshot travels to the widget
  // every poll, and an album name is not a place to carry a megabyte.
  return trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT) : trimmed
}

/**
 * Normalises the binary's JSON. Every field is optional but `available`, so a malformed answer
 * becomes "nothing is playing" rather than a widget full of `undefined`.
 */
export function parseNowPlaying(raw: string): NowPlayingSnapshot {
  let value: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { available: false }
    value = parsed as Record<string, unknown>
  } catch {
    return { available: false }
  }
  const state = value.state === 'playing' || value.state === 'paused' || value.state === 'stopped' ? value.state : undefined
  const title = text(value.title)
  const artist = text(value.artist)
  const album = text(value.album)
  const error = text(value.error)
  const available = value.available === true || title !== undefined || artist !== undefined || album !== undefined
  if (!available && error === undefined) return { available: false }
  return {
    available,
    state,
    title,
    artist,
    album,
    artwork: artwork(value.artwork),
    app: text(value.app),
    durationMs: number(value.durationMs),
    positionMs: number(value.positionMs),
    error,
  }
}

const artwork = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const data = value.trim()
  if (data === '') return undefined
  return data.length > MAX_ARTWORK ? undefined : data
}

export function createNowPlayingProvider(env: NodeJS.ProcessEnv = process.env, injected?: NowPlayingRun): Provider<NowPlayingSnapshot> {
  // A successful lookup is reused: the path does not change while the server runs. A failed one
  // is retried on the next call, so building or installing the helper is picked up without a
  // server restart — and a Mac without it only pays two stats per poll.
  let cached: Promise<NowPlayingRun> | undefined
  const run = async (): Promise<NowPlayingRun | null> => {
    if (injected) return injected
    if (cached) return cached
    const path = await resolveNowPlayingBinary(env)
    if (!path) return null
    cached = Promise.resolve(binaryRun(path))
    return cached
  }

  const gate = async (ctx?: CommandContext) => {
    if (!ctx?.loopback) return { ok: false as const, error: tr(undefined, 'provider.localOnly') }
    const binary = await run()
    if (!binary) return { ok: false as const, error: 'unavailable' }
    return { ok: true as const, binary }
  }

  const command = (name: 'previous' | 'next') => async (_payload: unknown, ctx?: CommandContext) => {
    const ready = await gate(ctx)
    if (!ready.ok) return ready
    await ready.binary(['command', FIXED_COMMANDS[name]])
    return { ok: true }
  }

  /**
   * One button, two commands: the state is read first, then the opposite is asked for. The
   * alternative — MediaRemote's TogglePlayPause — is a no-op in QuickTime Player on macOS 27,
   * which is exactly the player a local video opens in.
   */
  const playPause = async (_payload: unknown, ctx?: CommandContext) => {
    const ready = await gate(ctx)
    if (!ready.ok) return ready
    const state = parseNowPlaying(await ready.binary(['snapshot'])).state
    await ready.binary(['command', state === 'playing' ? 'pause' : 'play'])
    return { ok: true }
  }

  return {
    channel: 'now-playing',
    // One snapshot costs a process, a perl start and a MediaRemote read (~110 ms on an M4):
    // at one second that is a tenth of a core for a tile that draws no progress bar. Two
    // seconds still turns the play/pause glyph within a glance.
    intervalMs: 2000,
    async poll() {
      const binary = await run()
      // No binary is not an error to retry faster for: the widget draws its empty state, and a
      // Mac without the helper has nothing to fix.
      if (!binary) return { available: false, error: 'unavailable' }
      return parseNowPlaying(await binary(['snapshot']))
    },
    commands: { previous: command('previous'), playPause, next: command('next') },
  }
}
