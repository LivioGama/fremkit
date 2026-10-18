// The extension's own offer, filtered before it leaves the browser. The accepted ranges are those of
// `isLocalSdp` in server/src/companion/protocol.ts: keep the two in step.

function isLocalAddress(address) {
  if (address.endsWith('.local') && address.length > '.local'.length) return /^[a-z0-9.-]+$/i.test(address)
  const bare = address.split('%')[0].toLowerCase()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    const [a, b] = bare.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (bare.includes(':')) {
    if (bare === '::1') return true
    const first = bare.split(':')[0]
    if (first.length !== 4) return false
    const value = parseInt(first, 16)
    return (value >= 0xfe80 && value <= 0xfebf) || (value >= 0xfc00 && value <= 0xfdff)
  }
  return false
}

/** Drops every candidate that is not a `host` candidate on a loopback, private, link-local or `.local` address. */
export function localCandidatesOnly(sdp) {
  return sdp
    .split(/(?<=\n)/)
    .filter((line) => {
      if (!line.startsWith('a=candidate:')) return true
      const fields = line.trim().split(/\s+/)
      return fields[6] === 'typ' && fields[7] === 'host' && isLocalAddress(fields[4] ?? '')
    })
    .join('')
}
