import { execFileSync, spawn } from 'node:child_process'

/** A running advertisement; `stop` withdraws it. */
export interface Advertisement {
  stop(): void
}

/** `name` is the service instance name the Mac is listed under; `Fremkit` when omitted. */
export type Advertiser = (port: number, name?: string) => Advertisement

const DNS_SD = '/usr/bin/dns-sd'
const PGREP = '/usr/bin/pgrep'

/** The part of a child process the advertiser uses. */
export interface AdvertiserChild {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'error', cb: (err: Error) => void): unknown
}

/** What `createAdvertiser` runs; the defaults are the real ones, tests inject their own. */
export interface AdvertiserDeps {
  platform?: NodeJS.Platform
  spawn?: (cmd: string, args: string[]) => AdvertiserChild
  /** `pgrep -lf` output for a pattern: one `<pid> <command line>` per line, empty when none. */
  listProcesses?: (pattern: string) => string
  kill?: (pid: number) => void
  /** Registers a callback for the process's `exit`; returns its removal. */
  onExit?: (cb: () => void) => () => void
}

/** The exact argument list `dns-sd` is run with, so a stale one can be recognised by it. */
function dnsSdArgs(port: number, name: string): string[] {
  return ['-R', name, '_fremkit._tcp', 'local', String(port)]
}

const realDeps: Required<AdvertiserDeps> = {
  platform: process.platform,
  spawn: (cmd, args) => spawn(cmd, args, { stdio: 'ignore' }),
  listProcesses: (pattern) => {
    try {
      return execFileSync(PGREP, ['-l', '-f', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      // Exit status 1 is "nothing matched"; anything else only costs the clean-up.
      return ''
    }
  },
  kill: (pid) => {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone, or not ours to signal.
    }
  },
  onExit: (cb) => {
    process.on('exit', cb)
    return () => {
      process.removeListener('exit', cb)
    }
  },
}

/**
 * Kills the `dns-sd` an earlier run of the server left advertising this port: a server killed
 * before it could stop its child orphans it, and it keeps announcing a Mac nobody answers for.
 * Any `/usr/bin/dns-sd -R <any name> _fremkit._tcp local <this port>` is reaped whatever its name:
 * an orphan from an older version ("Fremkit") or from before the Mac was renamed is just as stale.
 * The port is bound by this server by now, so no live Fremkit can own that advertisement.
 */
function killStale(port: number, deps: Required<AdvertiserDeps>): void {
  // A regular expression to pgrep; the exact parse below is what decides.
  const output = deps.listProcesses('dns-sd -R .* _fremkit._tcp local')
  const own = new RegExp(`^${DNS_SD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -R .+ _fremkit\\._tcp local ${port}$`)
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+) (.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    if (!own.test(m[2].trim()) || pid === process.pid) continue
    deps.kill(pid)
  }
}

/**
 * Announces the remote listener on the LAN as `_fremkit._tcp`, so the device app can find the
 * Mac without typing an address. `dns-sd -R` keeps the registration for as long as it runs, so
 * stopping is killing it. Spawned with an argument list, never a shell. A no-op off macOS.
 *
 * The child is also killed from the process's `exit` event, synchronously, so a server that exits
 * without closing the app (an uncaught error, `process.exit`) does not leave it advertising. A
 * SIGKILL cannot be caught; the next start kills what it left behind.
 */
export function createAdvertiser(deps: AdvertiserDeps = {}): Advertiser {
  const d: Required<AdvertiserDeps> = { ...realDeps, ...deps }
  return (port, name = 'Fremkit') => {
    if (d.platform !== 'darwin') return { stop: () => undefined }
    killStale(port, d)
    const child = d.spawn(DNS_SD, dnsSdArgs(port, name))
    // A missing or failing dns-sd only costs discovery; the QR code still carries the address.
    child.on('error', () => undefined)
    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
    const removeExitHook = d.onExit(kill)
    return {
      stop: () => {
        removeExitHook()
        kill()
      },
    }
  }
}

export const advertise: Advertiser = createAdvertiser()

/** The advertiser the tests use: `dns-sd` must never run there. */
export const noAdvertise: Advertiser = () => ({ stop: () => undefined })
