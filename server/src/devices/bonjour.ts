import { spawn } from 'node:child_process'

/** A running advertisement; `stop` withdraws it. */
export interface Advertisement {
  stop(): void
}

export type Advertiser = (port: number) => Advertisement

const DNS_SD = '/usr/bin/dns-sd'

/**
 * Announces the remote listener on the LAN as `_fremkit._tcp`, so the device app can find the
 * Mac without typing an address. `dns-sd -R` keeps the registration for as long as it runs, so
 * stopping is killing it. Spawned with an argument list, never a shell. A no-op off macOS.
 */
export const advertise: Advertiser = (port) => {
  if (process.platform !== 'darwin') return { stop: () => undefined }
  const child = spawn(DNS_SD, ['-R', 'Fremkit', '_fremkit._tcp', 'local', String(port)], { stdio: 'ignore' })
  // A missing or failing dns-sd only costs discovery; the QR code still carries the address.
  child.on('error', () => undefined)
  return {
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    },
  }
}

/** The advertiser the tests use: `dns-sd` must never run there. */
export const noAdvertise: Advertiser = () => ({ stop: () => undefined })
