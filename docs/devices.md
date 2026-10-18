# Show the dashboard on an iPad

The Fremkit iPad app shows one screen of your dashboard from a Mac on the same network: real
widgets, live data, touch, Claude sessions. The iPad is a **paired device**: the Mac trusts it
explicitly, it can be revoked at any time, and nothing listens on the network until you turn it on.

The app is iPad only (iPadOS 17 or later). It is distributed through TestFlight; to build it
yourself see [Building the app](#building-the-app).

## Turn it on

In the admin, open **Screen → Devices** and switch on **Allow an iPad on the local network**.
Fremkit generates a key the first time and starts a second listener on port **4243**, over TLS,
with a self-signed certificate. macOS may ask whether to accept incoming connections for Fremkit:
accept. If another application holds port 4243 the admin says so and the switch goes back off.

The section then shows a QR code, the same pairing code in clear text, and a **fingerprint** of
four words. A code is valid for 5 minutes and works once; **New code** makes another.

## Pair

1. Open the Fremkit app on the iPad. Allow **Local Network** when it asks (it needs it to reach
   your Mac; see [Prompts](#prompts-on-the-ipad-and-the-mac)).
2. Scan the QR code. This is the normal path: the code carries the Mac's address and the hash of
   its key, so it needs no discovery and no typing. Opening the `fremkit://` link from the iPad's
   Camera app does the same.
3. The iPad measures the size its dashboard really gets (1408 × 950 on a 13-inch iPad Pro, for
   instance) and reports it. The device appears in the Devices section; pick the screen it shows,
   or **Create a screen its size**, and lay that screen out like any other.

**Without the camera**, the app lists the Macs it finds on the network (Bonjour, `_fremkit._tcp`).
Pick yours, type the code, and **check that the four words on the iPad are the ones the admin
shows** before you confirm: they come from your Mac's key, so a Mac that shows other words is not
yours. There is no field for typing an address: a Mac that is not in the list is reached with the
QR code.

The iPad keeps what it needs to reconnect in its keychain and pins the Mac's key: it talks to
that Mac and no other, whatever the network calls it. If the Mac's address changes, the app finds
it again by itself.

## What the iPad can do

It shows the screen you gave it and does what the Edge does on that screen: every widget, its
connections (the secrets stay on the Mac), Claude session focus, the clipboard. Only that screen:
a widget's connection, a shortcut button or a service probe placed on another screen is out of its
reach, and an iPad with no screen yet can use none. It cannot open
the admin or change anything in the configuration; those stay on the Mac. The status bar is
hidden and the screen stays awake while the app is in front.

**Brightness.** When a device screen is attached, the iPad sets that screen's brightness: the
admin's *Screen → Brightness*, the brightness widget and the day/night schedule are applied on
the iPad, and a change made in its Control Center is reported back. If the app is closed or in the
background for about 30 seconds, the admin and the widget say "The iPad is not showing this
screen right now" and keep the setting until the app is back.

## Revoke and reset

**Remove** in the Devices section revokes one iPad: its connection is closed at once, and the app
notices within 30 seconds (it checks that the Mac still knows it) and shows "This iPad is no
longer allowed"; **Pair again** leads to the welcome screen. **Remove every device** does it for
all of them. **Reset the certificate** makes a new key, which removes every device too: each iPad
shows "This Mac's key has changed" and must be paired again with **Pair again**. The app never
forgets a pairing by itself, and keeps retrying meanwhile, so an iPad that only met another
machine on the Mac's old address recovers on its own. Turning the switch off
closes the listener and the iPads show that the Mac is unreachable until it is back on.

## Prompts on the iPad and the Mac

- **Local Network** on the iPad. Without it nothing reaches the Mac. If you refused it: Settings →
  Privacy & Security → Local Network → Fremkit.
- **Incoming connections** on the Mac: the macOS firewall may ask once to let Fremkit's server
  accept them. Accept.

## Troubleshooting

- **The Mac is not in the list.** The router or access point may not relay Bonjour (mDNS) between
  Ethernet and Wi-Fi, between bands, or between VLANs; or the Mac is connected to both Wi-Fi and
  Ethernet. Use the QR code, which works without Bonjour, or put the Mac and the iPad on the same
  Wi-Fi.
- **The app says it cannot reach the Mac.** The Mac is asleep, pairing is switched off, or the
  Local Network permission was refused (above). The app retries by itself.
- **The app says "This Mac's key has changed".** The certificate was reset in Fremkit (or another
  machine answers at the Mac's address). Tap **Pair again** and pair as the first time; if you
  did not reset it, check that the iPad is on the right network.
- **The app says "This iPad is no longer allowed".** The device was removed in the admin: tap
  **Pair again**.
- **The four words differ.** Do not pair. Check that you picked your own Mac in the list; if the
  words still differ, use the QR code.
- **Brightness says "The iPad is not showing this screen right now".** Open the app and show that
  screen.

## What the Mac exposes

Only an allow-list of routes answers on port 4243: the dashboard's page, the widgets' code, and
what a paired dashboard reads and sends (`/api/config`, `/ws`, the proxy, the device's own
`GET /api/devices/me` and `POST /api/devices/me/brightness`). Anything else, the admin included,
answers 404. What does answer is narrowed to the iPad's own screen: `/api/config` and the `config`
channel carry that screen, its widgets, the theme and the language, and none of the connections,
marketplace records, privacy switches or other screens. See [SECURITY.md](../SECURITY.md#a-paired-device).

## Building the app

The Xcode project is `ios/Fremkit.xcodeproj`. Signing values never enter the repository:

```bash
cp ios/Local.example.xcconfig ios/Local.xcconfig   # git-ignored: your team id and bundle id
scripts/build-ios.sh build     # the simulator, unsigned: needs no Local.xcconfig
scripts/build-ios.sh test      # FremkitKit's tests (the pairing and connection logic)
FREMKIT_IOS_DEVICE=<udid> scripts/build-ios.sh install   # signed debug build onto your iPad
```

`xcodebuild` needs Xcode itself, not the Command Line Tools; the script finds `/Applications/Xcode.app`
(or `FREMKIT_XCODE`), and with your own commands `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`
does the same. Publishing is described in [releasing.md](releasing.md#the-ipad-app).
