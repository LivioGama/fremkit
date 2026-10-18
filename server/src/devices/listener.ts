/**
 * The TLS listener paired devices reach the dashboard on, beside the loopback one.
 *
 * It is not a second Fastify instance: it accepts TLS connections, marks each socket as remote
 * (`net/remote.ts`), and hands every request and upgrade to the app's own server, so both
 * listeners share one set of routes, one hub and one config — and every remote request meets
 * the devices gate first (`gate.ts`).
 */

import { createServer, type Server } from 'node:https'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { markRemoteSocket } from '../net/remote.js'

export const REMOTE_PORT = 4243

export class RemoteListener {
  private server: Server | null = null
  /** Every socket the listener holds open, the TCP ones and those upgraded to a WebSocket. */
  private readonly sockets = new Set<Socket>()
  private boundPort: number | null = null

  constructor(
    private readonly app: FastifyInstance,
    private readonly requestedPort = REMOTE_PORT,
  ) {}

  get running(): boolean {
    return this.server !== null
  }

  /** The port actually bound once started (what port 0 resolved to), the requested one before. */
  get port(): number {
    return this.boundPort ?? this.requestedPort
  }

  /**
   * Starts listening on every interface, IPv4 and IPv6 (`::`, dual-stack). Rejects with the
   * listen error — `code: 'EADDRINUSE'` when the port is taken — and leaves nothing listening.
   */
  async start(keyPem: string, certPem: string): Promise<void> {
    if (this.server) throw new Error('remote listener already running')
    await this.app.ready()
    const server = createServer({ key: keyPem, cert: certPem, minVersion: 'TLSv1.2' })
    const track = (socket: Socket): void => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    }
    server.on('connection', track)
    server.on('secureConnection', (socket: Socket) => {
      markRemoteSocket(socket)
      track(socket)
    })
    // Marked again on the way in, so a request can never reach the app looking local, whatever
    // order the events above come in.
    server.on('request', (req, res) => {
      markRemoteSocket(req.socket)
      this.app.server.emit('request', req, res)
    })
    server.on('upgrade', (req, socket: Socket, head: Buffer) => {
      markRemoteSocket(socket)
      this.app.server.emit('upgrade', req, socket, head)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // No host: Node binds `::`, which on macOS also accepts IPv4.
      server.listen(this.requestedPort)
    })
    server.on('error', (err) => this.app.log.warn({ err: err.message }, 'remote listener error'))
    this.boundPort = (server.address() as AddressInfo).port
    this.server = server
  }

  /** Closes the listener and destroys every socket it still holds, WebSockets included. */
  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    this.boundPort = null
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await closed
  }
}
