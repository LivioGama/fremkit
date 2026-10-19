import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMessages2FAProvider } from '../src/providers/messages-2fa.js'

const dirs: string[] = []
const APPLE_EPOCH_MS = 978_307_200_000

async function fixtureDatabase(sql: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fremkit-messages-2fa-'))
  dirs.push(dir)
  const path = join(dir, 'chat.db')
  execFileSync('/usr/bin/sqlite3', [path, sql])
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
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard })

    await expect(provider.commands?.copyLatest(null, { loopback: true }))
      .resolves.toEqual({ ok: true })
    expect(pasteboard.write).toHaveBeenCalledWith('482913')
  })

  it('finds verification text stored only in attributedBody', async () => {
    const now = Date.now()
    const date = Math.floor((now - APPLE_EPOCH_MS - 60_000) * 1_000_000)
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES (NULL, CAST('Your verification code is 734206' AS BLOB), 0, ${date});`)
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard })

    await expect(provider.commands?.copyLatest(null, { loopback: true }))
      .resolves.toEqual({ ok: true })
    expect(pasteboard.write).toHaveBeenCalledWith('734206')
  })

  it('ignores outgoing, expired and unrelated numeric messages', async () => {
    const now = Date.now()
    const recent = Math.floor((now - APPLE_EPOCH_MS - 60_000) * 1_000_000)
    const old = Math.floor((now - APPLE_EPOCH_MS - 6 * 60_000) * 1_000_000)
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES ('Security code 111111', NULL, 1, ${recent});
      INSERT INTO message VALUES ('Verification code 222222', NULL, 0, ${old});
      INSERT INTO message VALUES ('Order number 333333', NULL, 0, ${recent});`)
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard })

    await expect(provider.commands?.copyLatest(null, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'No recent verification code found.' })
    expect(pasteboard.write).not.toHaveBeenCalled()
  })

  it('refuses remote callers without reading Messages or touching the pasteboard', async () => {
    const run = vi.fn(async () => '[]')
    const pasteboard = { write: vi.fn(async (_text: string) => {}) }
    const provider = createMessages2FAProvider({ run, pasteboard })

    await expect(provider.commands?.copyLatest(null, { loopback: false }))
      .resolves.toEqual({ ok: false, error: 'Available only from this Mac.' })
    expect(run).not.toHaveBeenCalled()
    expect(pasteboard.write).not.toHaveBeenCalled()
  })

  it('fails closed on unsupported database schemas without exposing database content', async () => {
    const databasePath = await fixtureDatabase('CREATE TABLE unsupported (body TEXT);')
    const provider = createMessages2FAProvider({ databasePath })

    await expect(provider.commands?.copyLatest(null, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'Messages could not be read.' })
  })

  it('does not expose a code or raw database error if copying fails', async () => {
    const now = Date.now()
    const date = Math.floor((now - APPLE_EPOCH_MS - 60_000) * 1_000_000)
    const databasePath = await fixtureDatabase(`CREATE TABLE message (text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER);
      INSERT INTO message VALUES ('Passcode 765432', NULL, 0, ${date});`)
    const pasteboard = { write: vi.fn(async (_text: string) => { throw new Error('secret-bearing system error') }) }
    const provider = createMessages2FAProvider({ databasePath, now: () => now, pasteboard })

    await expect(provider.commands?.copyLatest(null, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'The code could not be copied.' })
  })
})
