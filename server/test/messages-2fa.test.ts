import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMessagePasteboardWriter, createMessages2FAProvider } from '../src/providers/messages-2fa.js'
import { tr } from '../src/i18n.js'

const dirs: string[] = []
const APPLE_EPOCH_MS = 978_307_200_000
const LONG_TYPEDSTREAM_VERIFIED = 'BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBK4GjAFlvdXIgdmVyaWZpY2F0aW9uIGNvZGUgaXMgNDgzOTIxIEFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUGGhAJpSQGBowCShISEDE5TRGljdGlvbmFyeQCUhAFpAIaG'
const LONG_TYPEDSTREAM_FIXTURE = 'BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBK4GjAFlvdXIgdmVyaWZpY2F0aW9uIGNvZGUgaXMgNDgzOTIxIEFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUGGhAJpSQGBowCShISEDE5TRGljdGlvbmFyeQCUhAFpAIaG'
// Synthetic Foundation NSArchiver/typedstream archive of an attributed string. Keeping this
// fixture local and synthetic exercises the same BLOB shape used by Messages without reading
// or retaining any user's chat database content.
const ATTRIBUTED_TYPEDSTREAM_BASE64 = 'BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBKyBZb3VyIHZlcmlmaWNhdGlvbiBjb2RlIGlzIDQ4MzkyMYaEAmlJASCShISEDE5TRGljdGlvbmFyeQCUhAFpAZKElpYQZXhhbXBsZUF0dHJpYnV0ZYaShJaWCXN5bnRoZXRpY4aGhg=='
const LONG_ATTRIBUTED_TYPEDSTREAM_BASE64 = 'BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBK4GjAEFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUEgWW91ciB2ZXJpZmljYXRpb24gY29kZSBpcyA0ODM5MjGGhAJpSQGBowCShISEDE5TRGljdGlvbmFyeQCUhAFpAIaG'

async function fixtureDatabase(sql: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fremkit-messages-2fa-'))
  dirs.push(dir)
  const path = join(dir, 'chat.db')
  execFileSync('/usr/bin/sqlite3', [path, `CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, style INTEGER);
    CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    ${sql}`])
  return path
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('Messages 2FA provider', () => {
  it('copies a recent incoming verification code on explicit local request', async () => {
    const now = Date.now()
    const date = Math.floor((now - APPLE_EPOCH_MS - 60_000) * 1_000_000)
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES ('Your verification code is 482913', NULL, 0, ${date});`)
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: true })
    expect(pasteboard.write).toHaveBeenCalledWith('482913')
  })

  it('finds verification text stored only in attributedBody', async () => {
    const now = Date.now()
    const date = Math.floor((now - APPLE_EPOCH_MS - 60_000) * 1_000_000)
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES (NULL, CAST('Your verification code is 734206' AS BLOB), 0, ${date});`)
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: true })
    expect(pasteboard.write).toHaveBeenCalledWith('734206')
  })

  it('extracts and copies a synthetic Foundation typedstream attributedBody', async () => {
    const now = Date.now()
    const date = Math.floor((now - APPLE_EPOCH_MS - 60_000) * 1_000_000)
    const typedstreamHex = Buffer.from(ATTRIBUTED_TYPEDSTREAM_BASE64, 'base64').toString('hex')
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES (NULL, X'${typedstreamHex}', 0, ${date});`)
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: true })
    expect(pasteboard.write).toHaveBeenCalledWith('483921')
  })

  it('reads typedstream lengths that use the two-byte prefix', async () => {
    const now = Date.now()
    const date = Math.floor((now - APPLE_EPOCH_MS - 60_000) * 1_000_000)
    const typedstreamHex = Buffer.from(LONG_TYPEDSTREAM_VERIFIED, 'base64').toString('hex')
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES (NULL, X'${typedstreamHex}', 0, ${date});`)
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: true })
    expect(pasteboard.write).toHaveBeenCalledWith('483921')
  })

  it('reads a full bounded result set with large attributed bodies', async () => {
    const now = Date.now()
    const date = Math.floor((now - APPLE_EPOCH_MS - 60_000) * 1_000_000)
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100)
      INSERT INTO message
      SELECT 'Your verification code is 483921' || replace(hex(zeroblob(4064)), '00', char(1)),
        zeroblob(${4096}), 0, ${date} - (100 - n) * 1000000000
      FROM seq;`)
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: true })
    expect(pasteboard.write).toHaveBeenCalledWith('483921')
  })

  it('ignores outgoing, expired and unrelated numeric messages', async () => {
    const now = Date.now()
    const recent = Math.floor((now - APPLE_EPOCH_MS - 60_000) * 1_000_000)
    const old = Math.floor((now - APPLE_EPOCH_MS - 6 * 60_000) * 1_000_000)
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES ('Security code 111111', NULL, 1, ${recent});
      INSERT INTO message VALUES ('Verification code 222222', NULL, 0, ${old});
      INSERT INTO message VALUES ('Order number 333333', NULL, 0, ${recent});
      INSERT INTO message VALUES ('Le digicode c''est 4821, et le login wifi…', NULL, 0, ${recent});`)
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: false, error: tr(undefined, 'messages2fa.noneFound') })
    expect(pasteboard.write).not.toHaveBeenCalled()
  })

  it('refuses remote callers without reading Messages or touching the pasteboard', async () => {
    const run = vi.fn(async () => '[]')
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ run, pasteboard, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: false, paired: false }))
      .resolves.toEqual({ ok: false, error: tr(undefined, 'messages2fa.localOnly') })
    expect(run).not.toHaveBeenCalled()
    expect(pasteboard.write).not.toHaveBeenCalled()
  })

  it('fails closed on unsupported database schemas without exposing database content', async () => {
    const databasePath = await fixtureDatabase('CREATE TABLE unsupported (body TEXT);')
    const provider = createMessages2FAProvider({ databasePath, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: false, error: tr(undefined, 'messages2fa.readFailed') })
  })

  it('does not expose a code or raw database error if copying fails', async () => {
    const now = Date.now()
    const date = Math.floor((now - APPLE_EPOCH_MS - 60_000) * 1_000_000)
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES ('Passcode 765432', NULL, 0, ${date});`)
    const pasteboard = { write: vi.fn(async (_text: string) => { throw new Error('secret-bearing system error') }) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: false, error: tr(undefined, 'messages2fa.copyFailed') })
  })

  it('prefers an actual code phrase and skips account endings and dates', async () => {
    const now = Date.now()
    const recent = Math.floor((now - APPLE_EPOCH_MS - 30_000) * 1_000_000)
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES ('A sign-in to the account ending 4821 … Your code: 739201', NULL, 0, ${recent} + 2);
      INSERT INTO message VALUES ('New login on 19/10/2026 … Verification code 482913', NULL, 0, ${recent});
      INSERT INTO message VALUES ('Votre code de connexion / de sécurité est 739201', NULL, 0, ${recent} - 1);
      INSERT INTO message VALUES ('Your verification code is 888888', NULL, 0, ${recent} + 1);
      INSERT INTO chat (style) VALUES (43);
      INSERT INTO chat_message_join VALUES (3, 1);`)
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: true })
    expect(pasteboard.write).toHaveBeenCalledWith('739201')
  })

  it('does not copy a verification code from a group chat', async () => {
    const now = Date.now()
    const recent = Math.floor((now - APPLE_EPOCH_MS - 30_000) * 1_000_000)
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES ('Your verification code is 888888', NULL, 0, ${recent});
      INSERT INTO chat (style) VALUES (43);
      INSERT INTO chat_message_join VALUES (1, 1);`)
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: false, error: tr(undefined, 'messages2fa.noneFound') })
    expect(pasteboard.write).not.toHaveBeenCalled()
  })

  it('recognizes a French verification-code phrase', async () => {
    const now = Date.now()
    const recent = Math.floor((now - APPLE_EPOCH_MS - 30_000) * 1_000_000)
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES ('Votre code de connexion / de sécurité est 739201', NULL, 0, ${recent});`)
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard, enabled: () => true })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: true })
    expect(pasteboard.write).toHaveBeenCalledWith('739201')
  })

  it('does not read Messages until its separate privacy setting is enabled', async () => {
    const run = vi.fn(async () => '[]')
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ run, pasteboard, enabled: () => false })

    await expect(provider.commands?.copyLatest(null, { loopback: true, paired: false }))
      .resolves.toEqual({ ok: false, error: tr(undefined, 'messages2fa.disabled') })
    expect(run).not.toHaveBeenCalled()
    expect(pasteboard.write).not.toHaveBeenCalled()
  })

  it('rate-limits repeated copy requests before spawning another database query', async () => {
    let now = 10_000
    const run = vi.fn(async () => '[]')
    const provider = createMessages2FAProvider({ run, now: () => now, enabled: () => true })
    const context = { loopback: true, paired: false }

    await provider.commands?.copyLatest(null, context)
    now += 1_000
    await expect(provider.commands?.copyLatest(null, context))
      .resolves.toEqual({ ok: false, error: tr(undefined, 'messages2fa.rateLimited') })
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('Messages 2FA pasteboard expiry', () => {
  it('conditionally clears the copied value if the cleanup child fails to start', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const executeScript = vi.fn(async (script: string, _args: string[], _stdin?: string) => script.includes('String(board.changeCount)') ? '41\n' : '')
    const spawnCleanup = vi.fn(() => child as never)
    const writer = createMessagePasteboardWriter({ executeScript, spawnCleanup })
    const result = writer.write('739201')
    await vi.waitFor(() => expect(spawnCleanup).toHaveBeenCalledTimes(1))

    child.emit('error', new Error('synthetic spawn failure'))

    await expect(result).rejects.toThrow('pasteboard cleanup could not be started')
    expect(executeScript).toHaveBeenCalledTimes(2)
    expect(executeScript.mock.calls[0]?.[1]).toEqual([])
    expect(executeScript.mock.calls[0]?.[2]).toBe('739201')
    expect(spawnCleanup).toHaveBeenCalledWith(41)
    expect(executeScript.mock.calls[1]?.[0]).toContain('board.clearContents()')
    expect(executeScript.mock.calls[1]?.[1]).toEqual(['41'])
  })

  it('conditionally clears the copied value if a started cleanup child exits unsuccessfully', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const executeScript = vi.fn(async (script: string, _args: string[], _stdin?: string) => script.includes('String(board.changeCount)') ? '42\n' : '')
    const spawnCleanup = vi.fn(() => child as never)
    const writer = createMessagePasteboardWriter({ executeScript, spawnCleanup })
    const result = writer.write('482913')
    await vi.waitFor(() => expect(spawnCleanup).toHaveBeenCalledTimes(1))

    child.emit('spawn')
    await expect(result).resolves.toBeUndefined()
    child.emit('exit', 1)
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(2))
    expect(executeScript.mock.calls[0]?.[1]).toEqual([])
    expect(executeScript.mock.calls[0]?.[2]).toBe('482913')
    expect(spawnCleanup).toHaveBeenCalledWith(42)
    expect(executeScript.mock.calls[1]?.[0]).toContain('board.clearContents()')
    expect(executeScript.mock.calls[1]?.[1]).toEqual(['42'])
  })
})
