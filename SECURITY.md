# Security

Fremkit is a dashboard for one person's own Mac. That shapes everything below: what it defends
against, what it deliberately does not, and what you are trusting when you run it.

## The shape of it

The server listens on `127.0.0.1:4242` and nowhere else, and answers only a caller that shows
its **local access secret**. That leaves three attackers worth defending against, and the code is
written around them; the secret is described first because every one of them meets it.

### The local access secret

The helper makes a new secret — 32 random bytes — for every server it starts, and hands it over
in an environment variable the server removes as soon as it has read it. A server started by hand
(`pnpm start`, `pnpm dev`) makes its own. Once it listens, the server writes it to
`~/Library/Application Support/Fremkit/access-<port>.token` (under `FREMKIT_SUPPORT_DIR` when that
is set), readable by your account only (mode `0600`), replacing the file in one rename, and
removes the file when it exits. It is never logged, never returned by the API and never quoted in
an error.

**The server proves itself first.** Whatever answers on the port is not necessarily Fremkit:
another account on the Mac could bind 4242 while the server is down — at login, or while the
helper waits to restart it — and wait for the secret. So before the helper sends the secret or
shows a page from the port, it asks `/auth/proof` with a random nonce and no credential, and only
a listener that answers with the right HMAC of that nonce under the secret is treated as the
server. Anything else is shown in the **F** menu as *port 4242 is held by another program*; the
Edge and the admin window load nothing from it, and the helper starts its own server once the
port is free. Because the secret changes with every server and its file goes with the server,
scripts that read the file find nothing to send while no server runs, and a secret picked up
from a server that has since died opens nothing.

Every request must carry it, in one of two ways:

- **`Authorization: Bearer <secret>`**, for programs: the helper, the Claude Code hook scripts,
  `curl`. The scripts hand it to `curl` through a file descriptor, never on the command line,
  where any account on the Mac could read it with `ps`.
- **A session cookie**, `HttpOnly` and `SameSite=Strict`, for pages. A page gets it by following
  a one-time link, `/auth?code=…`: the code is minted by someone who already holds the secret
  (*Open the admin in the browser* in the **F** menu, `pnpm open`, the helper itself for the Edge
  and the admin window), works once, and expires after a minute. Following it opens a *session*:
  the cookie holds a random session id the server keeps in memory, **never the secret**. A
  session ends after a day unused, after a week at most, when the page signs out
  (`DELETE /api/auth/session`), and for every page at once when the server stops. Browsers send a
  host's cookies to every port on that host, so a program listening on another loopback port can
  see the cookie; what it sees cannot mint a code, cannot be presented as a bearer, and dies with
  the session. Opening `127.0.0.1:4242` without either shows a page saying how to get in.

The comparison takes the same time wherever two values differ. A request without the secret is
told **401**.

Three routes answer without it, and only to reads:

- `/auth`, which is where the cookie is obtained, and which takes a one-time code instead.
- `/fremkit.js` and `/widgets/<id>/…`, the widgets' own files. A widget runs in a sandboxed frame
  with an opaque origin, and a browser treats every request such a frame makes as cross-site, so
  a `SameSite` cookie never goes with them (Chrome drops it; Safari's engine happens to send it,
  which is not something to build on). These files are the bytes the repository and the registry
  publish, carry no data of yours, and come with the widget CSP whatever opens them; everything a
  widget *does* goes through the host page, which holds the cookie. The cost is that a page can
  tell which widgets are installed by asking for them.

The exemption is decided by the route the server matched, not by the text of the path, so a
path that only *looks* like a widget file is not let through.

**What the secret does not protect against.** Anything running as you can read the token file,
just as it can read your keychain, your config and your clipboard without Fremkit's help: the
secret keeps out other accounts on the Mac and anything that can reach the port without being
able to read your files, not malware in your own account. A browser holding the cookie is signed
in until its session ends (see above) or the server restarts; a page in that browser is still held off by
the Host and Origin checks below, which stay in place, not by the secret. The Host and Origin
checks still run first: a request from a rebinding page is told 421, and a write from another
site 403, whatever it carries.

### A web page in your browser

Any page you visit can try to talk to `127.0.0.1:4242`. It cannot read most answers — the browser
enforces that — but it can *send*, and it can embed. So:

- Every request whose `Host` header is not one of the loopback names we answer to is refused with
  a **421**. That is what kills DNS rebinding, where a page gets `evil.example` to resolve to
  `127.0.0.1` and then talks to us as itself.
- Every request that is not a read requires an `Origin` we serve. A request with no `Origin` at
  all passes this check: that is `curl`, the Claude Code hook scripts and the native helper, none
  of which is a browser doing cross-site work — and each of which still has to show the secret.
- The cookie is `SameSite=Strict`, so a page on another site that sends a request to us — a form,
  an `<img>`, a `fetch` with `no-cors` — sends it without the cookie and is refused before any
  route runs. These checks were the whole defence before the secret existed; they stay, so a
  mistake in one is not the end of the other.
- The reads that *cause* something — fetching a favicon, proxying for a widget, asking a device
  for its options, downloading a backup — additionally refuse a request whose `Sec-Fetch-Site`
  says `cross-site`, which is the only signal a cross-site `<img>` or `<script>` gives.
- Every answer carries `X-Content-Type-Options: nosniff`, and the ones that hand back bytes from
  elsewhere also carry `Content-Security-Policy: default-src 'none'; sandbox`, so a browser
  talked into treating one as a document gets an inert one.
- The dashboard and the admin carry their own CSP: only scripts from this server, no plugins, no
  `<base>`, frames only from `/widgets/`, and `frame-ancestors 'none'` — no other page can frame
  them. It is written for the origin the page came from: 4242, a second checkout's port, or a
  paired device's `https://<mac>:4243` (`hostCsp` in `server/src/http/headers.ts`; under
  `pnpm dev`, Vite sends the same one from `ui/vite.config.ts`).

### A third-party widget

A widget is a folder of HTML and JavaScript. It is **untrusted code**, and it runs in a
`sandbox="allow-scripts"` iframe *and* under a CSP served with its own files, so the two hold even
if someone opens `/widgets/<id>/index.html` directly. The document has an opaque origin: nothing
it does counts as coming from `http://127.0.0.1:4242`.

What a widget **cannot** do:

- Reach the network directly. `connect-src 'none'`: `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource`, `sendBeacon` and `WebTransport` are dead inside a widget. Every call goes through
  `Fremkit.fetch`, the host, and the proxy, which only allows the hosts the manifest declares —
  never a private, loopback, link-local or reserved address, in any spelling.
- Use WebRTC. No CSP directive covers it (Chrome and WebKit ignore `webrtc 'block'`), and a peer
  connection would reach any STUN or TURN server, or any candidate address, with the widget's
  data in it. So the bridge, which the server places ahead of everything the widget wrote, makes
  `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`, `RTCSessionDescription` and
  `RTCIceCandidate` undefined, non-writable and non-configurable before any widget code runs; a
  child frame that could hold a fresh copy is refused by `frame-src 'none'`. The one exception
  is a **built-in** widget on a list in the server (`server/src/widgets/webrtc.ts`, Fremplay alone today):
  it gets a wrapped `RTCPeerConnection` with no ICE server, ever, that drops every candidate not
  on loopback or on one of this Mac's own addresses. A widget from the registry never gets
  WebRTC — not from its manifest, not through the consent dialog.
- Navigate its frame anywhere but another widget document. A sandboxed frame may navigate
  itself, and `location = 'https://…?d=<data>'` would send the data in the request. The
  dashboard and the admin carry a CSP whose `frame-src` is `<their own origin>/widgets/`, and the
  helper's kiosk and admin windows cancel any frame navigation outside `/widgets/` themselves.
  Only a widget's `index.html` runs script there: its other HTML, SVG or XML files are served
  with `script-src 'none'`.
- Read a channel its manifest does not declare, or send a command on one. `config`, which carries
  the whole dashboard, cannot be declared at all.
- Act on something that is not its own. A command that does something on your behalf — pressing a
  shortcut button, probing a service — names only *its own instance*, and the host stamps that
  identity itself; the target is then read from your saved settings. A widget cannot press
  another widget's buttons, and cannot name an application or a URL of its own.
- Keep talking after navigating itself. The host answers a widget over a `MessagePort` handed to
  the document that said hello, and only once that document has repeated a nonce on it; a port
  does not survive a navigation, so nothing the host sends afterwards reaches the next document.
  A second hello from the same frame, or a reload of it, and the host drops its subscriptions and
  stops answering.
- Press ▶ on a channel it was not granted. A settings `preview` must name one of the widget's
  `commands`; the grant drops a preview its commands no longer cover, and the admin sends one
  only on a channel the widget may command.
- Have an image of its choosing fetched. `Fremkit.image` fetches an address only when it is in
  the instance's own settings — what you typed, not a default the manifest wrote.
- Store anything. `localStorage` throws in an opaque origin.

What a widget **can** do, and what that means for you: a widget that declares `homey:*` can drive
every settable device on your Homey, and one that declares `shortcuts` can press the buttons you
configured on *its own* tile. The admin shows what each widget asks for — under the widget in the
library, and in full in its inspector — so read that before installing one from elsewhere.

### An installed widget

A widget from the [registry](https://github.com/fdussert/fremkit-sietch) is the same untrusted
code as any other, in the same sandbox, under the same CSP. Two things are different.

It is held to **what you accepted**, not to what it asks for. Installing it records the three
permission lists as they were shown to you; the manifest on disk is only the ask, and everything
downstream — the channels the host relays, the hosts the proxy fetches — is handed the
intersection of the two. A channel the manifest declares and your record does not is refused
exactly like one that was never declared. That is what makes "an update whose permissions grew
asks again" a property of the server rather than a promise the dialog makes: an update that
quietly widened its own manifest would gain nothing by it. An installed widget with no record at
all — a folder dropped into `data/widgets` by hand — gets nothing.

And it is checked on the way in. The index is fetched over https from one host, every URL it
names must be on that host, a redirect is refused, and the package's sha256 is verified **before
a single zip entry is read**. Then the package rules run again on this side — no dotfile, no
symlink, no climbing path, no nested archive, size ceilings, a manifest that validates, an `sdk`
this build speaks, an `id` that is the one you asked for and is not a built-in's, and no private
host in `permissions.network`. The registry applies the same rules at pull-request time; neither
side trusts the other. The whole chain is described in
[docs/marketplace.md](docs/marketplace.md#what-the-installer-checks).

What none of that protects you from is a widget that does exactly what it said and is simply
malicious about it. The registry is curated by pull request and the review reads what a widget
does with the permissions it asks for — but the thing to read before pressing Install is the
list in the dialog.

A widget may also **declare a connection** — a service it needs credentials for, described in
its own manifest rather than coded into Fremkit. What that widget can reach is narrower than it
sounds, and deliberately so. It never holds the credential: it asks the server for a *path*, and
the server checks the method and that path against the exact list of requests you were shown
before installing, adds the credential, and returns the answer. Anything not on the list is a
403. The credential goes to the address **you** typed and to nothing else — a redirect is an
error rather than a hop, and the address cannot be changed without the key being asked for
again. A path that a service might route differently from the matcher (`..`, `%2f`, an empty
segment) is refused before it is matched. The widget may set a body and two headers,
`Content-Type` and `Accept`; `Authorization`, `Cookie` and `Host` are refused, because each is a
way of reaching past the proxy. Plain HTTP is honoured only for an address on your own network,
where there is no certificate to be had.

The thing this does *not* protect you from is the same as above: a widget doing exactly what it
declared, on data you agreed it could reach. The list in the dialog is the thing to read.

### Remote data rendered by a widget

Calendar titles, volume names, printer fields, pull request titles: none of it is yours, all of it
reaches a screen. The bridge provides `Fremkit.esc()`, `Fremkit.el()` and `Fremkit.color()`, and
the widgets here use them. See the Security section of
[docs/writing-widgets.md](docs/writing-widgets.md).

### A browser extension

The [Fremkit Companion](docs/companion.md) extension is the one thing that talks to the server
without the local access secret, because an extension cannot be handed it: the secret is a file in
your account, and an extension has no way to read your files. It is let in by a different door, and
the door is narrow.

**Its credential.** An extension is linked by your approval: it asks, the server shows a
four-character code on the Edge and in the admin, and you press Allow. The extension then collects
its token with a `POST` (Chrome sends no `Origin` on an extension's `GET` to `127.0.0.1`, which is
why it is not a `GET`). The token is 32 random bytes; only its `sha256` is stored, compared in
constant time. A code lasts two minutes, and one request waits at a time: while it waits, a
request from another install is answered 409 and does not take its place; only the same install
can replace its own. Five requests a minute are accepted in total, three per install, and an
install whose request was refused is turned away for a minute. Allow and Refuse send the code they
showed, and the server answers 409 when it is not the waiting request's, so an answer never lands
on a request swapped in after you read the code; Allow is also held off for two seconds whenever
the request on show changes. The name shown is one of a closed list of browser names (Chrome,
Microsoft Edge, Brave, Arc, Opera, Vivaldi, Chromium). An approved request that is never collected is
removed when it expires.
Removing the extension in **Screen → Devices** closes its socket and its token stops working.

**The routes that skip the secret**, decided by the route the server matched, like the widgets'
files:

- `POST /api/companion/pair` and `POST /api/companion/pair/:requestId`, which each check for an
  `Origin` that is an extension's (`chrome-extension://` and 32 letters) before doing anything.
- `GET /companion/ws`, the socket. The extension opens it with a `challenge` naming its record
  and a fresh nonce; the server answers with an HMAC of that nonce keyed by the token's stored
  `sha256`, which the extension checks before it sends its token in `hello`. The token must
  belong to that same record, whose origin *and* install id match what the socket presents, and
  the whole exchange must finish within five seconds; anything else is closed.

Allowing and refusing a request stay behind the secret and are local-only. None of these routes
exists on the remote listener (4243). The `companion` channel the dashboard watches is built-in
only, and paired iPads are refused it entirely.

**What a web page can do.** Not pair: it has no extension `Origin`, which a page cannot forge, and
the pairing still needs your press on the Edge. It cannot open the socket without a token, and it
cannot read one. It can tell that Fremkit runs: the socket upgrades before it closes with 1008, which
says no more than the HTTP server on port 4242 already does, and is accepted as such. At most eight
sockets may be short of their hello at once (one more is closed with 1013), and a share's metadata
refreshes reach the dashboard at most four times a second.

**What another extension can do.** It has its own `chrome-extension://` origin, so it can ask to
pair, and the request shows its name and code on the Edge; the code is meant to be compared, and a
request you did not make is refused. If you allow it, it is a Companion like any other, with what
that carries below. Do not allow a request you did not start.

**What a linked extension can do**, and it is little: send metadata about the video being shared
(a title, a host, a position), and a WebRTC offer, to the Edge. It cannot read your dashboard, your
config or your connections, call any other API, or send a command to a widget other than
driving its own share. Its offer may only name this Mac — host candidates on loopback, a `.local`
name or one of the Mac's own addresses — so the kiosk is never sent to another machine on the
network, and the video does not leave your Mac; it never goes through the server either. The
picture is cropped to the page's main video element; a page can make that element cover the whole
tab, frames from other sites included, but the picture only goes to your own dashboard. The
extension asks for another site's frames only when you allow that site, after its popup has named
it, and gives the grant back when that site's frame holds no video. It drives the video from its
isolated world (only YouTube's volume goes through the page's own), keeps its token where code it
injects into a page cannot read it, and listens only to its own pages.

**What a local program can do.** A process running as you can read the access secret and anything
else; it is out of scope, as under *Known limits*. One running as another account, or anything that
reaches the port without reading your files, cannot pair without you being at the Edge to allow it.
It can, however, post a pairing request: an `Origin` header is only a header to a program that is
not a browser, and the per-install limits count an install id it picks. Fremkit cannot tell such a
request from yours, which is why the code matters: the one in your popup must be the one on the
Edge, and the server only approves the code that was on show. A program that keeps a request of its
own waiting can hold pairing up (you then see a request you did not start: refuse it), but it cannot
swap its request in under your Allow. Nor can it learn a linked extension's token by holding port
4242 in Fremkit's place: it cannot answer the challenge, so the token is never sent, and without the
token it never sees an offer to answer, which is what keeps the video from it. The extension also
drops the answer's candidates that are not loopback or a `.local` name, as defence in depth only:
WebRTC learns the receiver's address from its incoming checks whatever the answer lists. Such a
program can make the extension show itself removed (an unproven refusal), but the token stays until
you pair again. Pairing with it gives it a token it made up itself, never the real one.

## What Fremkit reads on your Mac

Transcripts, the clipboard, Dock badges, a keychain item — the full list, with who reads what and
when, is in the [README](README.md#what-fremkit-reads-on-your-mac). Two things worth repeating
here:

- Reading the **Claude Code OAuth token** from the keychain is **off by default** and turned on
  explicitly in /admin → Screen → Privacy. It is presented to `api.anthropic.com` and nowhere
  else, and is never stored or logged.
- Connection secrets live in the **macOS keychain** (or `data/secrets.json` if you chose the file
  backend). They are never returned by the API, never logged, never quoted in an error, and never
  included in a backup. A stored secret also cannot follow a changed destination: change the host
  of a connection and you are asked for the secret again.

## The native helper

The helper (`native/`) is a small AppKit app that owns the kiosk window, the HID touch driver and
the Dock badges, and supervises the server process.

- **Its TCC grants are real, and they reach its children.** Input Monitoring and Accessibility
  let it read the touch panel and post synthetic mouse events. macOS attributes the Node server
  and the programs it runs (such as `fremkit-scan`) to the helper as their responsible app, so a
  file-access grant made to "Fremkit Helper" — Files and Folders, or Full Disk Access — is also
  the server's.
- **Full Disk Access is optional.** Only the disk map benefits from it: without it, the folders
  macOS protects are shown as unreadable. With it, the helper, the server and every provider can
  read every file of the account. Grant it only if you want those folders measured.
- **It is signed with a self-signed identity** created by
  `scripts/create-signing-identity.sh` ("Fremkit Helper Dev"), because macOS ties TCC grants to
  the signature: without a stable one you would re-approve the permissions after every build.
  That identity is trusted for code signing **in your login keychain only** — nothing is added to
  the system trust store — and its private key is imported non-extractable and usable by
  `codesign` alone. It is not notarised, and it is not a substitute for a Developer ID.
- **The kiosk cannot be navigated away from**: a main-frame navigation off the dashboard's origin
  is cancelled, and WebKit's context menu is removed, because the Edge has no keyboard and no
  window chrome to get back with. In the kiosk and in the admin window, a **frame** may only
  load a widget document (`<origin>/widgets/…`); anything else is cancelled before the request
  leaves.
- **macOS Local Network** permission belongs to the *responsible app* — "Fremkit Helper" under the
  helper, your terminal otherwise. Deleting the helper's bundle drops the grant, which is why the
  install script replaces its contents in place.

## Known limits

These are real and not fixed. They are here so you can decide whether they matter to you.

- **Bambu Lab LAN mode has no certificate to verify.** The printer serves a self-signed
  certificate on both the MQTT port and the camera port, so Fremkit connects without verifying
  it: the traffic is encrypted but the peer is not authenticated. Anything on the same network
  that can answer for the printer's address can receive the LAN access code. See
  [docs/connections.md](docs/connections.md#what-the-tls-does-and-does-not-prove).
- **A same-user process is out of scope.** It can read your keychain, your config and your
  clipboard without going through Fremkit at all — and the access secret's token file, which is
  readable by your account by design so the scripts can use it.
- **The widgets' own files are served without the secret** (see above), so a page you visit can
  find out which widgets are installed, though not how they are set up or what they show.
- **The registry is trusted to be curated, not to be safe.** An installed widget can do
  everything you granted it, and a permission list that looks reasonable can still be used
  badly — there is no sandbox that tells "shows my calendar" from "sends my calendar somewhere".
  The index carries no signature: the trust is in GitHub Pages serving what the workflow built,
  and in the hash and the https host, which stop the bytes changing on the way rather than
  proving who wrote them.
- **A Synology on the LAN has no certificate to verify either.** `allowSelfSigned` exists for
  exactly that, off by default and per connection; turned on, the traffic is encrypted but the
  peer is not authenticated. See [docs/connections.md](docs/connections.md#synology).
- **The Claude usage endpoint is undocumented.** `api.anthropic.com/api/oauth/usage` is not a
  published API and may change or disappear.
- **WebKit preconnects whatever the CSP says.** A widget's `<link rel="preconnect"
  href="https://<anything>.example">` makes WebKit — the kiosk, the admin window, Safari —
  resolve that name and open a TCP connection to it; no request is sent, but the name itself
  reaches a DNS server the widget's author may run. Chrome honours the CSP and does not. No
  header or CSP directive turns it off for a document; `scripts/check-widget-sandbox.ts`
  watches it.
- **DNS rebinding is closed for the widget proxy and the favicons, not for declared
  connections.** A widget's `GET` through the proxy and every favicon fetch connect through a
  lookup that judges the very address the socket is opened on, so a name that answers a public
  address to the check and `127.0.0.1` to the connection is refused. A declared connection
  reaches the host *you* typed, LAN included, on purpose, and is not judged that way.

## Reporting something

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability
reporting on this repository — the **Security** tab, then **Report a vulnerability** — which
opens a private thread with the maintainer.

Useful in a report: what an attacker has to control (a web page you visit, a widget you
installed, a device on your network), what they get, and the shortest way to reproduce it. There
is no bounty; this is one person's side project, and it will be read and answered.
