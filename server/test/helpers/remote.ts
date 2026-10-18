import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DEFAULT_OPENSSL, ensureKey, issueCertificate } from '../../src/devices/certificate.js'
import { FileSecretStore } from '../../src/secrets/file.js'

export const hasOpenssl = spawnSync(DEFAULT_OPENSSL, ['version']).status === 0

/** A key and certificate made the way the app makes them (Task 3), for a listener in a test. */
export async function tlsMaterial(): Promise<{ key: string; cert: string }> {
  const secrets = new FileSecretStore(join(await mkdtemp(join(tmpdir(), 'fremkit-remote-tls-')), 'secrets.json'))
  const key = await ensureKey(secrets)
  const cert = await issueCertificate(key, { host: 'example.local', addresses: ['127.0.0.1'] })
  return { key, cert }
}

export interface RemoteResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

export interface RemoteRequest {
  method?: string
  path: string
  /** The `Host` header; defaults to `127.0.0.1:<port>`. */
  host?: string
  headers?: Record<string, string>
  body?: string
}

/** One HTTPS request to the remote listener on `port`, over a fresh connection. */
export function remote(port: number, req: RemoteRequest): Promise<RemoteResponse> {
  return new Promise((resolve, reject) => {
    const r = httpsRequest({
      host: '127.0.0.1',
      port,
      method: req.method ?? 'GET',
      path: req.path,
      headers: { host: req.host ?? `127.0.0.1:${port}`, ...req.headers },
      rejectUnauthorized: false,
      agent: false,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      res.on('error', reject)
    })
    r.on('error', reject)
    if (req.body !== undefined) r.end(req.body)
    else r.end()
  })
}

/**
 * A WebSocket handshake on `/ws`. Resolves with the upgraded socket on 101, or with the status
 * and body of the answer that refused it.
 */
export function upgrade(
  port: number,
  headers: Record<string, string>,
  host = `127.0.0.1:${port}`,
): Promise<{ status: 101; socket: Socket; head: Buffer } | { status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpsRequest({
      host: '127.0.0.1',
      port,
      path: '/ws',
      headers: {
        host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
      rejectUnauthorized: false,
      agent: false,
    })
    r.on('upgrade', (_res, socket, head) => resolve({ status: 101, socket, head }))
    r.on('response', (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    r.on('error', reject)
    r.end()
  })
}
