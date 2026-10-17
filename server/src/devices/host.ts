import { networkInterfaces } from 'node:os'
import { execFileAsync, type Exec } from '../secrets/keychain.js'

/** What a Bonjour local host name may contain; anything else is treated as unknown. */
const HOST_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

/**
 * The Mac's Bonjour name (`<name>.local` on the LAN), from `scutil --get LocalHostName`.
 * Null when the command fails or prints something that is not a plain host label.
 */
export async function localHostName(exec: Exec = execFileAsync): Promise<string | null> {
  try {
    const { stdout } = await exec('scutil', ['--get', 'LocalHostName'])
    const name = stdout.trim()
    return HOST_NAME_RE.test(name) ? name : null
  } catch {
    return null
  }
}

/** The non-internal IPv4 addresses of every interface, deduplicated and sorted. */
export function lanAddresses(): string[] {
  const out = new Set<string>()
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.add(info.address)
    }
  }
  return [...out].sort()
}
