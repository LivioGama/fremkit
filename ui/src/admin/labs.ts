/**
 * The admin's experimental features: what is hidden until `config.labs` turns it on, and the
 * gesture that shows the switch.
 *
 * iPad pairing and adding screens ship before the iPad app does. Until it is out they stay out of
 * sight behind `labs.devices` — the admin only; the server does what `devices.json` says either
 * way. The switch itself sits in Screen → About and appears after the version number is clicked
 * seven times, the way a phone's developer options do.
 */
import { ref } from 'vue'
import type { Config } from '../shared/types'
import type { DeviceStatus } from '../shared/api'

/** True when iPad pairing and adding screens are shown. */
export function labsDevices(config: Config | null | undefined): boolean {
  return config?.labs?.devices === true
}

/**
 * True when pairing is in use on this Mac: the listener is on, or a device is paired. Read from
 * `GET /api/devices`, since that state lives in `devices.json`, not in the config.
 */
export function pairingInUse(status: DeviceStatus | null | undefined): boolean {
  return status?.enabled === true || (status?.devices.length ?? 0) > 0
}

/**
 * The Devices section: shown with the flag on, and whenever pairing is in use whatever the flag
 * says — the section is the only way to switch the listener off or unpair an iPad, and hiding it
 * would leave a paired device with no way to be revoked.
 */
export function showsDevices(config: Config | null | undefined, status: DeviceStatus | null | undefined): boolean {
  return labsDevices(config) || pairingInUse(status)
}

/**
 * The screen selector and its "Add a screen": shown with the flag on, and to anyone who already
 * has several screens whatever the flag says — hiding a screen they use would strand it.
 */
export function showsScreens(config: Config | null | undefined): boolean {
  return labsDevices(config) || (config?.screens.length ?? 0) > 1
}

/** Clicks on the version that reveal the switch. */
export const REVEAL_TAPS = 7
/** All of them within this long of the first one; a slower series starts over. */
export const REVEAL_WINDOW_MS = 4000

/**
 * Whether the switch has been revealed in this admin session. Module-level so it survives the
 * inspector being closed and opened again; a reload hides it again unless the flag is on.
 */
const revealed = ref(false)

let taps = 0
let firstAt = 0

/**
 * One click on the version. Answers true on the click that reveals the switch, and only then:
 * clicks after it, or while it is already shown, change nothing.
 */
export function tapVersion(now: number = Date.now()): boolean {
  if (revealed.value) return false
  if (taps === 0 || now - firstAt > REVEAL_WINDOW_MS) {
    taps = 0
    firstAt = now
  }
  taps += 1
  if (taps < REVEAL_TAPS) return false
  taps = 0
  revealed.value = true
  return true
}

/** The switch is shown once revealed, and always while the flag is on, so it can be turned off. */
export function labsShown(config: Config | null | undefined): boolean {
  return revealed.value || labsDevices(config)
}

/** Back to a fresh session: for tests. */
export function resetLabsReveal(): void {
  revealed.value = false
  taps = 0
  firstAt = 0
}
