# Fremkit Companion

Fremkit Companion is a browser extension that sends the **video** playing in a browser tab to the
Fremplay widget on your Edge, and gives you touch controls for it there: play and pause, seek
10 seconds, volume, mute, fill the tile, bring the tab back, stop.

It is optional. Nothing in Fremkit needs it except the Fremplay widget, which shows how to get it
until an extension is linked.

## What you need

- A Chromium browser: Chrome, Edge, Brave or Arc. Firefox and Safari are not supported.
- Fremkit running, and a screen with the Fremplay widget on a page.

## Install

The extension lives in `companion/` in this repository. Until it is published on the Chrome Web
Store, load it unpacked:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Press **Load unpacked** and choose the `companion/` folder.
3. Pin the Fremkit icon to the toolbar if you like.

The extension's ID is fixed by the `key` in its manifest: `lnckeodobpbbmfbdlpnegjpchgkehdlk`. That
is the ID the store listing will have (publication is pending), so a link made with the unpacked
copy keeps working when you switch to the store version. The server accepts any extension origin, and what makes
one yours is that you allowed it on the Edge.

## Link it to Fremkit

1. Click the Fremkit icon and press **Connecter à Fremkit** (*Connect to Fremkit*).
2. The popup shows a four-character code. The same code appears on the Edge, and in
   the admin under **Screen → Devices**.
3. Check the codes match and press **Allow** on the Edge (or in the admin). **Refuse** drops the
   request.

The code is valid for two minutes, and Fremkit takes at most five pairing requests a minute, from
all extensions together. When you allow the request the extension collects its own credential;
you do not type anything anywhere. See [SECURITY.md](../SECURITY.md#a-browser-extension) for what
that credential is.

Linked extensions are listed in **Screen → Devices**, where you can rename or remove them.
Removing one closes its connection at once, and the extension goes back to showing the **Connect**
button; link it again the same way.

## Send a video to the Edge

Play a video, then either click the Fremkit icon and press **Envoyer sur l'Edge** (*Send to the
Edge*), or press **⌥⇧E**. Press it again to stop. The shortcut can be changed at
`chrome://extensions/shortcuts`, or from the extension's options page.

- **Only the video is sent**, never the whole tab. The page's other content never leaves your
  browser.
- **The sound stays in the browser.** The Edge shows the picture; volume and mute act on the
  video in your browser.
- The Edge **switches to the page holding the Fremplay widget**. If the Edge's screen has no
  Fremplay widget, the popup tells you so and nothing is sent.
- The browser can be in the background, on another tab or another desktop. Quitting it, or
  closing the tab, ends the share.
- The video travels directly between the browser and the Edge over WebRTC, using local-network
  addresses only. It does not go through the Fremkit server and it does not leave your machine.
  A share with no sign of life for ten seconds (the tab moved on to a page without a video) is
  cleared.

### Players from another site

Some videos play in a frame from another site (Dailymotion embeds, for instance). The first time
you share one, the browser asks you to allow the extension on **that site**. Allowing it is a
per-site grant that you can revoke at any time in `chrome://extensions`. The extension asks for no
access to every site at install.

## Limits

- Chromium browsers only.
- Video only: never a whole tab, never audio alone.
- Video protected by DRM (some streaming services) is not promised to work: the browser may hand
  over a black picture.
- If the server restarts during a share the video keeps playing, and the controls come back when
  the extension reconnects.

## Troubleshooting

- *"Install Fremkit Companion in Chrome, then tap Connect"* — no extension is linked. Link one
  as above.
- *"Browser closed or extension inactive"* — the linked extension is not connected. Open the
  browser; if it is open, click the icon, which wakes the extension.
- *"The video is not coming through: stop the share and start it again"*
- *"Fremplay and Fremkit speak different versions: update Fremkit"*
