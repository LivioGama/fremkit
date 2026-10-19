import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { CommandContext, Provider } from './types.js'
import { pbPasteboard, type Pasteboard } from './clipboard.js'

const MESSAGES_DB = join(homedir(), 'Library', 'Messages', 'chat.db')
const APPLE_EPOCH_MS = 978_307_200_000
const WINDOW_MS = 5 * 60_000
const QUERY_LIMIT = 100
const COMMAND_TIMEOUT_MS = 2_500
const CODE_LENGTH = /^\d{4,8}$/
const RequestSchema = z.null()

interface MessageRow {
  text?: unknown
  date?: unknown
}

type Run = (file: string, args: string[]) => Promise<string>

interface Messages2FAOptions {
  databasePath?: string
  now?: () => number
  run?: Run
  pasteboard?: Pick<Pasteboard, 'write'>
}

const defaultRun: Run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 128 * 1024, shell: false }, (error, stdout) => {
    if (error) reject(new Error('Messages could not be read.'))
    else resolve(stdout)
  })
})

function timestampBounds(now: number): { appleSeconds: number; appleNanoseconds: number } {
  const cutoff = now - WINDOW_MS - APPLE_EPOCH_MS
  return { appleSeconds: Math.floor(cutoff / 1000), appleNanoseconds: Math.floor(cutoff * 1_000_000) }
}

function appleDateToUnixMs(value: unknown): number | undefined {
  const date = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(date) || date <= 0) return undefined
  const unixMs = date > 1_000_000_000_000
    ? date / 1_000_000 + APPLE_EPOCH_MS
    : date * 1000 + APPLE_EPOCH_MS
  return Number.isFinite(unixMs) ? unixMs : undefined
}

function hasVerificationContext(text: string, start: number, end: number): boolean {
  const context = text.slice(Math.max(0, start - 70), Math.min(text.length, end + 70))
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
  return /\b(?:verification|security|authentication|authenticator|passcode|sign[ -]?in|login|one[ -]?time|otp)\b/.test(context)
}

function verificationCode(text: string): string | undefined {
  const pattern = /(?<!\d)\d{4,8}(?!\d)/g
  for (const match of text.matchAll(pattern)) {
    const code = match[0]
    const start = match.index
    if (start !== undefined && CODE_LENGTH.test(code) && hasVerificationContext(text, start, start + code.length)) {
      return code
    }
  }
  return undefined
}

async function latestVerificationCode(
  databasePath: string,
  now: number,
  run: Run,
): Promise<string | undefined> {
  const bounds = timestampBounds(now)
  const query = `SELECT trim(coalesce(text, '') || ' ' || coalesce(cast(attributedBody AS text), '')) AS text, date FROM message
    WHERE is_from_me = 0 AND (text IS NOT NULL OR attributedBody IS NOT NULL)
      AND length(coalesce(text, '') || ' ' || coalesce(cast(attributedBody AS text), '')) <= 4096
      AND ((date > 1000000000000 AND date >= ${bounds.appleNanoseconds})
        OR (date <= 1000000000000 AND date >= ${bounds.appleSeconds}))
    ORDER BY date DESC LIMIT ${QUERY_LIMIT};`
  const stdout = await run('/usr/bin/sqlite3', [
    '-readonly', '-json', '-batch',
    '-cmd', 'PRAGMA query_only=ON;',
    '-cmd', '.timeout 1000',
    databasePath,
    query,
  ])
  let rows: unknown
  try { rows = JSON.parse(stdout || '[]') } catch { throw new Error('Messages could not be read.') }
  const parsed = z.array(z.object({ text: z.string().max(4096), date: z.union([z.number(), z.string()]) })).safeParse(rows)
  if (!parsed.success) throw new Error('Messages could not be read.')

  for (const row of parsed.data as MessageRow[]) {
    const sentAt = appleDateToUnixMs(row.date)
    if (sentAt === undefined || sentAt < now - WINDOW_MS || sentAt > now + 60_000) continue
    const code = verificationCode(row.text as string)
    if (code) return code
  }
  return undefined
}

/** Reads only recent incoming message text on an explicit local tap; never polls or logs content. */
export function createMessages2FAProvider(options: Messages2FAOptions = {}): Provider {
  const databasePath = options.databasePath ?? MESSAGES_DB
  const now = options.now ?? Date.now
  const run = options.run ?? defaultRun
  const pasteboard = options.pasteboard ?? pbPasteboard

  return {
    channel: 'messages-2fa',
    commands: {
      copyLatest: async (payload: unknown, context?: CommandContext) => {
        if (context?.loopback !== true) return { ok: false, error: 'Available only from this Mac.' }
        if (!RequestSchema.safeParse(payload).success) return { ok: false, error: 'Invalid request.' }
        let code: string | undefined
        try { code = await latestVerificationCode(databasePath, now(), run) } catch {
          return { ok: false, error: 'Messages could not be read.' }
        }
        if (!code) return { ok: false, error: 'No recent verification code found.' }
        try { await pasteboard.write(code) } catch {
          return { ok: false, error: 'The code could not be copied.' }
        }
        // Keep the OTP on the local pasteboard only; never return it over the widget bridge.
        return { ok: true }
      },
    },
  }
}
