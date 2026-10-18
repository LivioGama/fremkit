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
copy keeps working when you switch to the store version. The server accepts any extension origin,
and what makes one yours is that you allowed it on the Edge.

## Link it to Fremkit

1. Click the Fremkit icon and press **Connecter à Fremkit** (*Connect to Fremkit*).
2. The popup shows a four-character code. The same code appears on the Edge, and in
   the admin under **Screen → Devices**.
3. Check the codes match and press **Allow** on the Edge (or in the admin). **Refuse** drops the
   request.

The code is valid for two minutes, and Fremkit takes at most five pairing requests a minute, from
all extensions together, and three from any one install. One request waits at a time: pressing
*Connect* again in the same browser replaces your own, but another extension asking meanwhile is
told *Another pairing request is already waiting on the Edge*. A refused request makes that browser
wait a minute before asking again. The extension's name on the Edge is the browser's (Chrome,
Microsoft Edge, Brave, Arc, Opera, Vivaldi or Chromium), never a text of its choosing.

**Compare the codes.** Any program on this Mac can post a pairing request; Fremkit cannot tell it
from yours. What protects you is that the code in your popup is the one on the Edge: Allow and
Refuse carry the code they showed, and Fremkit turns the answer down (*The request changed; check
the code*) if the request waiting is no longer that one. Allow also stays off for two seconds
whenever a different request appears, so a request swapped in just as you tap is not the one
approved.

When you allow the request the extension collects its own credential;
you do not type anything anywhere. See [SECURITY.md](../SECURITY.md#a-browser-extension) for what
that credential is.

Each time it connects, the extension first has the server prove that it holds this extension's
record, and sends its credential only then: another program listening on the port in Fremkit's
place cannot learn it, and the popup says *The server on this port is not your Fremkit*. Pairing
is different: it involves no secret yet, so the extension trusts whatever answers on Fremkit's port
at that moment. A program that already holds port 4242 when you press **Connect** (Fremkit was not
running, or was restarting) can approve the request itself, pair the extension with itself instead
of Fremkit, and then receive every video you share afterwards. It never learns the real credential,
but it does not need it. Nothing the extension can check tells such a program from Fremkit, since
whatever holds Fremkit's port also serves the dashboard, so:

- Press **Connect** only when the code the popup shows is on the Edge, and allow it there yourself.
  The extension refuses an approval that comes back less than two seconds after its request, which
  no hand on the Edge is fast enough for, but a program can simply wait.
- If the popup says the extension was removed and you did not remove it in **Screen → Devices**,
  do not reconnect: another program may be answering instead of Fremkit. Quit it, or restart the
  Mac, and the extension finds Fremkit again on its own.

Linked extensions are listed in **Screen → Devices**, where you can rename or remove them.
Removing one closes its connection at once, and the extension goes back to showing the **Connect**
button; link it again the same way.

## Send a video to the Edge

Play a video, then either click the Fremkit icon and press **Envoyer sur l'Edge** (*Send to the
Edge*), or press **⌥⇧E**. Press it again to stop. The shortcut can be changed at
`chrome://extensions/shortcuts`, or from the extension's options page.

- **The picture is cropped to the page's main video**: the largest video element visible in the
  tab, playing or not, without its sound. The page decides where that video sits, so a page that
  makes it cover the whole tab sends the whole tab's picture, frames from other sites included.
  Whatever it shows, the picture only goes to your own dashboard on this Mac.
- **The sound stays in the browser.** The Edge shows the picture; volume and mute act on the
  video in your browser.
- The Edge **switches to the page holding the Fremplay widget**. If the Edge's screen has no
  Fremplay widget, the popup tells you so and nothing is sent.
- The browser can be in the background, on another tab or another desktop. Quitting it, or
  closing the tab, ends the share.
- The video travels directly between the browser and the Edge over WebRTC, between addresses of
  this Mac only: loopback, or the Mac's own (the Fremplay widget dials nothing else, and the
  server refuses to relay any other). It does not go through the Fremkit server and it does not
  leave your machine.
  A share with no sign of life for ten seconds (the tab moved on to a page without a video) is
  cleared.

### Players from another site

Some videos play in a frame from another site (Dailymotion embeds, for instance). The first time you
share one, the popup names **that site** (*Fremplay needs access to … to find the video*), and
pressing the button lets the browser ask you to allow it. The extension cannot look inside the frame
before you do, so check the name: unless the share starts and that site's frame holds a video, the
extension gives the permission back as the attempt ends. A grant is per site, and you can revoke it
at any time in `chrome://extensions`. The extension asks for no access to every site at install.

## Limits

- Chromium browsers only.
- Video only, never audio: the picture of the page's main video, which a page can make as large
  as the whole tab.
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
- *"The server on this port is not your Fremkit"* (in the extension's popup) — something else
  answered on Fremkit's port and could not prove it is your Fremkit, so the extension kept its
  credential to itself. Quit whatever else uses port 4242 and start Fremkit; the extension
  keeps trying on its own.
- *"The Edge refused the video connection"* (in the extension's popup) — the browser offered an
  address that is not one of this Mac's (a network interface that changed during the share, for
  instance), and Fremkit relays nothing else. The share ends; send it again.
- *"Fremplay and Fremkit speak different versions: update Fremkit"*
