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
// 100 rows can contain either 4 KiB of JSON-escaped text or 4 KiB of hex BLOB data.
// Keep the whole result bounded while allowing the full recent-message window through.
const MAX_QUERY_OUTPUT_BYTES = 3 * 1024 * 1024
const CODE_LENGTH = /^\d{4,8}$/
const MAX_ATTRIBUTED_BODY_BYTES = 4_096
const RequestSchema = z.null()

interface MessageRow {
  text?: string
  attributedHex?: string
  date?: number | string
}

type Run = (file: string, args: string[]) => Promise<string>

interface Messages2FAOptions {
  databasePath?: string
  now?: () => number
  run?: Run
  pasteboard?: Pick<Pasteboard, 'write'>
}

const defaultRun: Run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_QUERY_OUTPUT_BYTES, shell: false }, (error, stdout) => {
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

function decodeTypedstreamAttributedBody(hex: string): string | undefined {
  if (hex.length === 0 || hex.length > MAX_ATTRIBUTED_BODY_BYTES * 2 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined
  const bytes = Buffer.from(hex, 'hex')
  const isTypedstream = bytes.length >= 13 && bytes[0] === 4 && bytes[1] === 11 && bytes.subarray(2, 13).toString('ascii') === 'streamtyped'
  if (!isTypedstream) {
    // Keep compatibility with older/test databases that stored plain UTF-8 in attributedBody;
    // reject binary/control-heavy payloads rather than heuristically scraping them.
    try {
      const plain = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return plain && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(plain) ? plain : undefined
    } catch {
      return undefined
    }
  }

  // Messages stores NSAttributedString bodies as NSArchiver typedstreams. The actual plaintext
  // is the unshared NSString value immediately following its class declaration. Parse its
  // length prefix as bytes; decoding the whole archive as SQLite TEXT stops at embedded NULs.
  const stringClass = Buffer.from('NSString', 'ascii')
  const classIndex = bytes.indexOf(stringClass, 13)
  if (classIndex < 0) return undefined
  const classEnd = classIndex + stringClass.length
  const markerIndex = bytes.indexOf(0x2b, classEnd)
  if (markerIndex < classEnd || markerIndex - classEnd > 32) return undefined

  let cursor = markerIndex + 1
  const tag = bytes[cursor++]
  let length: number
  if (tag <= 0x7f) length = tag
  else if (tag === 0x81 && cursor + 2 <= bytes.length) {
    length = bytes.readUInt16LE(cursor)
    cursor += 2
  } else if (tag === 0x82 && cursor + 4 <= bytes.length) {
    length = bytes.readUInt32LE(cursor)
    cursor += 4
  } else if (tag === 0x83 && cursor + 8 <= bytes.length) {
    const longLength = bytes.readBigUInt64LE(cursor)
    if (longLength > BigInt(MAX_ATTRIBUTED_BODY_BYTES)) return undefined
    length = Number(longLength)
    cursor += 8
  } else return undefined

  if (length <= 0 || length > MAX_ATTRIBUTED_BODY_BYTES || cursor + length > bytes.length) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor, cursor + length))
  } catch {
    return undefined
  }
}

async function latestVerificationCode(
  databasePath: string,
  now: number,
  run: Run,
): Promise<string | undefined> {
  const bounds = timestampBounds(now)
  const query = `SELECT coalesce(text, '') AS text,
      CASE WHEN text IS NULL OR text = '' THEN coalesce(hex(attributedBody), '') ELSE '' END AS attributedHex,
      date FROM message
    WHERE is_from_me = 0 AND (text IS NOT NULL OR attributedBody IS NOT NULL)
      AND length(coalesce(text, '')) <= 4096
      AND (attributedBody IS NULL OR length(attributedBody) <= ${MAX_ATTRIBUTED_BODY_BYTES})
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
  const parsed = z.array(z.object({ text: z.string().max(4096), attributedHex: z.string().max(MAX_ATTRIBUTED_BODY_BYTES * 2), date: z.union([z.number(), z.string()]) })).safeParse(rows)
  if (!parsed.success) throw new Error('Messages could not be read.')

  for (const row of parsed.data as MessageRow[]) {
    const sentAt = appleDateToUnixMs(row.date)
    if (sentAt === undefined || sentAt < now - WINDOW_MS || sentAt > now + 60_000) continue
    const body = row.text || decodeTypedstreamAttributedBody(row.attributedHex ?? '') || ''
    const code = verificationCode(body)
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
