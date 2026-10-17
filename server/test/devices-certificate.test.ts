import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtemp, readdir } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_OPENSSL,
  TLS_KEY_SECRET,
  ensureKey,
  issueCertificate,
  resetKey,
  spkiHash,
} from '../src/devices/certificate.js'
import { lanAddresses, localHostName } from '../src/devices/host.js'
import { FileSecretStore } from '../src/secrets/file.js'
import { assertSecretKey } from '../src/secrets/types.js'
import type { Exec } from '../src/secrets/keychain.js'

const hasOpenssl = spawnSync(DEFAULT_OPENSSL, ['version']).status === 0

async function tempStore(): Promise<FileSecretStore> {
  return new FileSecretStore(join(await mkdtemp(join(tmpdir(), 'fremkit-tls-test-')), 'secrets.json'))
}

const namesA = { host: 'example.local', addresses: ['192.0.2.10'] }
const namesB = { host: 'example.local', addresses: ['198.51.100.7', '192.0.2.20'] }

/** An exec that fails the way `execFile` does: the command line, with its arguments, in the message. */
const failingExec: Exec = async (cmd, args) => {
  throw Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}`), {
    code: 1,
    stderr: 'unable to load key',
  })
}

describe('pairing TLS key and certificate', () => {
  it('stores the key under a valid secret key', () => {
    expect(() => assertSecretKey(TLS_KEY_SECRET)).not.toThrow()
  })

  it.skipIf(!hasOpenssl)('returns the same key on every call', async () => {
    const secrets = await tempStore()
    const first = await ensureKey(secrets)
    expect(first).toMatch(/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n/)
    expect(await ensureKey(secrets)).toBe(first)
    expect(await secrets.get(TLS_KEY_SECRET)).toBe(first)
  })

  it.skipIf(!hasOpenssl)('generates a single key for overlapping first calls', async () => {
    const secrets = await tempStore()
    const [a, b] = await Promise.all([ensureKey(secrets), ensureKey(secrets)])
    expect(a).toBe(b)
    expect(await secrets.get(TLS_KEY_SECRET)).toBe(a)
  })

  it.skipIf(!hasOpenssl)('keeps the SPKI hash across certificates for different addresses', async () => {
    const key = await ensureKey(await tempStore())
    const certA = await issueCertificate(key, namesA)
    const certB = await issueCertificate(key, namesB)
    expect(certA).not.toBe(certB)
    expect(spkiHash(certA)).toBe(spkiHash(certB))
    expect(spkiHash(certA)).toBe(spkiHash(key))
    expect(spkiHash(certA)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it.skipIf(!hasOpenssl)('issues a ten-year self-signed certificate with the SANs', async () => {
    const key = await ensureKey(await tempStore())
    const cert = new X509Certificate(await issueCertificate(key, namesA))
    expect(cert.subjectAltName).toContain('DNS:example.local')
    expect(cert.subjectAltName).toContain('IP Address:192.0.2.10')
    expect(cert.subject).toBe('CN=fremkit')
    expect(cert.ca).toBe(false)
    expect(cert.issuer).toBe(cert.subject)
    expect(cert.verify(cert.publicKey)).toBe(true)
    const days = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86_400_000
    expect(Math.round(days)).toBe(3650)
  })

  it.skipIf(!hasOpenssl)('issues a certificate without SANs when there are no names', async () => {
    const key = await ensureKey(await tempStore())
    const cert = new X509Certificate(await issueCertificate(key, { host: null, addresses: [] }))
    expect(cert.subjectAltName).toBeUndefined()
  })

  it.skipIf(!hasOpenssl)('changes the hash when the key is reset', async () => {
    const secrets = await tempStore()
    const before = spkiHash(await ensureKey(secrets))
    const reset = await resetKey(secrets)
    expect(spkiHash(reset)).not.toBe(before)
    expect(await ensureKey(secrets)).toBe(reset)
  })

  it('keeps the key out of the error when openssl fails', async () => {
    const key = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIPLACEHOLDER\n-----END EC PRIVATE KEY-----\n'
    const err = await issueCertificate(key, namesA, { exec: failingExec }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).not.toContain('BEGIN')
    expect(message).not.toContain('PLACEHOLDER')
    expect(message).not.toContain('subjectAltName')
    expect(message).toContain('code 1')
  })

  it('removes its temporary directory when openssl fails', async () => {
    const seen: string[] = []
    const exec: Exec = async (cmd, args) => {
      seen.push(args[args.indexOf('-key') + 1]!)
      return failingExec(cmd, args)
    }
    await issueCertificate('not a key', namesA, { exec }).catch(() => undefined)
    const dir = join(seen[0]!, '..')
    await expect(readdir(dir)).rejects.toThrow()
  })

  it('reports a failed key generation without storing anything', async () => {
    const secrets = await tempStore()
    const err = await ensureKey(secrets, { exec: failingExec }).catch((e: unknown) => e)
    expect((err as Error).message).toContain('code 1')
    expect(await secrets.get(TLS_KEY_SECRET)).toBeNull()
  })

  it('refuses names that could not be written safely into the config', async () => {
    const exec: Exec = async () => ({ stdout: '' })
    await expect(issueCertificate('k', { host: 'a\n[v3]', addresses: [] }, { exec })).rejects.toThrow()
    await expect(issueCertificate('k', { host: null, addresses: ['192.0.2.1,DNS:x'] }, { exec })).rejects.toThrow()
  })
})

describe('host identity', () => {
  it('reads the local host name through scutil', async () => {
    const calls: Array<[string, string[]]> = []
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, args])
      return { stdout: 'example\n' }
    }
    expect(await localHostName(exec)).toBe('example')
    expect(calls).toEqual([['scutil', ['--get', 'LocalHostName']]])
  })

  it('returns null when scutil fails or prints something odd', async () => {
    expect(await localHostName(failingExec)).toBeNull()
    expect(await localHostName(async () => ({ stdout: 'bad name\n' }))).toBeNull()
  })

  it('lists sorted, external IPv4 addresses only', () => {
    const list = lanAddresses()
    for (const address of list) {
      expect(isIPv4(address)).toBe(true)
      expect(address.startsWith('127.')).toBe(false)
    }
    expect(list).toEqual([...list].sort())
  })
})
