# Security

Fremkit is a dashboard for one person's own Mac. That shapes everything below: what it defends
against, what it deliberately does not, and what you are trusting when you run it.

## The shape of it

The server listens on `127.0.0.1:4242` and nowhere else, and answers only a caller that shows
its **local access secret**. That leaves three attackers worth defending against, and the code is
written around them; the secret is described first because every one of them meets it.

### The local access secret

Every launch of the helper makes a new secret — 32 random bytes — and hands it to the server it
starts, in an environment variable the server removes as soon as it has read it. A server started
by hand (`pnpm start`, `pnpm dev`) makes its own. The server writes it to
`~/Library/Application Support/Fremkit/access-<port>.token` (under `FREMKIT_SUPPORT_DIR` when that
is set), readable by your account only (mode `0600`), replacing the file in one rename at every
start. It is never logged, never returned by the API and never quoted in an error.

Every request must carry it, in one of two ways:

- **`Authorization: Bearer <secret>`**, for programs: the helper, the Claude Code hook scripts,
  `curl`. The scripts hand it to `curl` through a file descriptor, never on the command line,
  where any account on the Mac could read it with `ps`.
- **A cookie**, `HttpOnly` and `SameSite=Strict`, for pages. The helper writes it straight into
  its own web views — the Edge and the admin window — before loading them. A browser gets it by
  following a one-time link, `/auth?code=…`: the code is minted by someone who already holds the
  secret (*Open the admin in the browser* in the **F** menu, `pnpm open`), works once, and
  expires after a minute. Opening `127.0.0.1:4242` without it shows a page saying how to get in.

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
in until it forgets the cookie or the helper restarts; a page in that browser is still held off by
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

### A third-party widget

A widget is a folder of HTML and JavaScript. It is **untrusted code**, and it runs in a
`sandbox="allow-scripts"` iframe *and* under a CSP served with its own files, so the two hold even
if someone opens `/widgets/<id>/index.html` directly. The document has an opaque origin: nothing
it does counts as coming from `http://127.0.0.1:4242`.

What a widget **cannot** do:

- Reach the network directly. There is no `connect-src` at all: `fetch`, `XMLHttpRequest` and
  `WebSocket` are dead inside a widget. Every call goes through `Fremkit.fetch`, the host, and the
  proxy, which only allows the hosts the manifest declares — never a private, loopback,
  link-local or reserved address, in any spelling.
- Read a channel its manifest does not declare, or send a command on one. `config`, which carries
  the whole dashboard, cannot be declared at all.
- Act on something that is not its own. A command that does something on your behalf — pressing a
  shortcut button, probing a service — names only *its own instance*, and the host stamps that
  identity itself; the target is then read from your saved settings. A widget cannot press
  another widget's buttons, and cannot name an application or a URL of its own.
- Keep talking after navigating itself. If a widget replaces its own document, the host drops its
  subscriptions and stops answering it.
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

### A paired device

Off by default: until you switch it on in the admin, nothing listens beyond `127.0.0.1`. Turned
on, a second listener answers on port 4243, **TLS only**, with a self-signed key the iPad app pins
(the hash of its public key travels in the pairing QR code, and the app shows four words from it
to compare when you pair without the camera). A device holds a random token that the Mac stores as
a hash; revoking the device, or resetting the certificate, ends it at once, open WebSocket
included. The listener drops any peer outside the local networks — RFC 1918 and link-local IPv4,
unique-local and link-local IPv6, and the Mac itself — before the TLS handshake, so a VPN peer or a
host on a global IPv6 address gets nothing. Pairing needs a single-use code, valid five minutes;
`/api/pair` answers 404 unless a code is live, and wrong guesses are limited per address (5 a
minute) under a total ceiling (60 a minute), so one guesser cannot lock another iPad out.

The remote listener is an **allow-list**, decided by the socket a request arrived on rather than
by a header: the dashboard's page and its code, the routes a dashboard reads, `/ws`, the widget
proxy, and the device's own `GET /api/devices/me` and `POST /api/devices/me/brightness`. Everything
else, the admin and every route that writes the configuration or reads a secret, answers 404. A
paired socket may subscribe to and command only what the widgets of its own screen declare — on a
per-connection channel (`calendar:<id>`, `github:<id>`), only the connections those widgets are
bound to, with the same refusal as a channel that does not exist — and a
device acts only on the instances of its own screen: the widget proxy (and so a widget's stored
credential) and the commands that resolve an instance refuse any instance shown elsewhere, and a
device with no screen acts on none. The configuration it reads, over HTTP and on the WebSocket,
is its own screen's — the theme, the language, that screen and the widgets on it — never your
connections, the marketplace records, the privacy switches or any other screen; the widget
catalogue lists only the widgets on its screen, without the scan's errors, and the installed
applications and their icons go only to a screen that shows a widget allowed to read them. In the iPad app, a frame inside the dashboard may load only
the Mac's `/widgets/…`, the same rule as the Edge's kiosk. See
[docs/devices.md](docs/devices.md).

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
  window chrome to get back with.
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
- **DNS rebinding has a race no application can win.** The proxy resolves a host and judges the
  address, then `fetch` resolves it again; a name that changes between the two is not caught.
  What is caught is a widget simply *asking* for a private address.

## Reporting something

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability
reporting on this repository — the **Security** tab, then **Report a vulnerability** — which
opens a private thread with the maintainer.

Useful in a report: what an attacker has to control (a web page you visit, a widget you
installed, a device on your network), what they get, and the shortest way to reproduce it. There
is no bounty; this is one person's side project, and it will be read and answered.
