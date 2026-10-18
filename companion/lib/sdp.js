// The extension's own offer, filtered before it leaves the browser. The accepted ranges are those of
// `isLocalSdp` in server/src/companion/protocol.ts: keep the two in step.

// Strict dotted quad: four decimal octets in 0..255, no leading zeros (what net.isIP accepts).
function isIPv4(s) {
  const parts = s.split('.')
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)
}

// The shape net.isIP accepts: hex groups of 1-4 digits, at most one `::`, an optional trailing IPv4.
function isIPv6(s) {
  if (s.split('::').length > 2 || /:::/.test(s)) return false
  const compressed = s.includes('::')
  let count = 0
  const parts = s.split(':')
  for (let i = 0; i < parts.length; i++) {
    const g = parts[i]
    if (g === '') continue
    if (i === parts.length - 1 && g.includes('.')) {
      if (!isIPv4(g)) return false
      count += 2
    } else if (/^[0-9a-f]{1,4}$/i.test(g)) count += 1
    else return false
  }
  // Without `::` every group is present; with it at least one is elided. A lone leading or trailing `:` is malformed.
  if (compressed) return count < 8 && !(s.startsWith(':') && !s.startsWith('::')) && !(s.endsWith(':') && !s.endsWith('::'))
  return count === 8 && !parts.includes('')
}

function isLocalAddress(address) {
  if (address.endsWith('.local') && address.length > '.local'.length) return /^[a-z0-9.-]+$/i.test(address)
  const bare = address.split('%')[0].toLowerCase()
  if (isIPv4(bare)) {
    const [a, b] = bare.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (isIPv6(bare)) {
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
