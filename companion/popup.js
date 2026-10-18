// The toolbar popup: the Fremkit header with the link state, the Fremplay card, the modules to come,
// and the pairing view while the browser is not linked. Everything it shows comes from
// chrome.storage, which the worker writes; it asks the worker to act and re-renders on changes.

import { localize, t } from './i18n.js'
import { browserName } from './lib/browser.js'
import { embeddedPlayer, pickVideo, survey } from './lib/video.js'

localize()

const $ = (id) => document.getElementById(id)
const ask = (type, extra = {}) => chrome.runtime.sendMessage({ target: 'worker', type, ...extra }).catch(() => null)

const ERRORS = {
  noVideo: () => t('noVideo'),
  noWidget: () => t('errNoWidget'),
  protocol: () => t('errProtocol'),
  unreachable: () => t('errUnreachable'),
  capture: () => t('errCapture'),
  unpaired: () => t('errUnpaired'),
  noVideoLeft: () => t('errNoVideoLeft'),
  needsPermission: () => t('errNeedsPermission'),
  failed: () => t('errFailed'),
}
const PAIR_ERRORS = {
  refused: () => t('pairRefused'),
  expired: () => t('pairExpired'),
  limited: () => t('pairLimited'),
  unreachable: () => t('pairUnreachable'),
  failed: () => t('pairFailed'),
}
const LINKS = {
  ok: ['ok', () => t('linkOk')],
  connecting: ['wait', () => t('linkConnecting')],
  unreachable: ['ko', () => t('linkUnreachable')],
  revoked: ['ko', () => t('linkRevoked')],
  unpaired: ['', () => t('linkUnpaired')],
}

const browser = browserName(navigator.userAgentData?.brands)
let local = {}
let session = {}
let tab = null
/** What the popup found in the tab: the main video, or an embedded player to ask access for. */
const video = { checked: false, picked: null, askOrigin: null, restricted: false }
let busy = false
/** A start is under way: the popup closes once it is accepted, from the reply or from storage. */
let starting = false
let shownError = null

const hostOf = (url) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

async function inspectTab() {
  video.checked = false
  video.picked = null
  video.askOrigin = null
  video.restricted = false
  if (!Number.isInteger(tab?.id) || tab.id < 0) {
    video.restricted = true
  } else {
    try {
      // The popup's activeTab grant lets it look before offering the button.
      const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: survey })
      video.picked = pickVideo(frames)
      const origin = embeddedPlayer(frames, video.picked)
      if (origin && !(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) video.askOrigin = origin
    } catch {
      // chrome:// pages, the Web Store, the PDF viewer…
      video.restricted = true
    }
  }
  video.checked = true
}

function renderLink() {
  const paired = Boolean(local.token)
  const link = paired ? (session.link === 'unpaired' ? 'connecting' : (session.link ?? 'connecting')) : local.revoked ? 'revoked' : 'unpaired'
  const [cls, label] = LINKS[link] ?? LINKS.connecting
  $('link').className = `pill ${cls}`
  $('linktext').textContent = label()
  $('device').textContent = paired ? t('footerLinked', local.name || browser) : t('footerUnpaired', browser)
}

function renderPairing() {
  const now = Date.now()
  const pending = local.pairing && local.pairing.expiresAt > now ? local.pairing : null
  $('connect').hidden = Boolean(pending)
  $('connect').disabled = busy
  $('code').hidden = !pending
  if (pending) {
    const left = Math.ceil((pending.expiresAt - now) / 1000)
    $('digits').textContent = pending.code
    $('valid').textContent = t('pairValid', `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)
  }
  const error = pending ? null : (PAIR_ERRORS[local.pairError]?.() ?? (local.revoked ? t('pairRevoked') : null))
  $('pairerror').hidden = !error
  $('pairerror').textContent = error ?? ''
}

function renderShortcut(shortcut) {
  const hint = $('hint')
  hint.replaceChildren()
  if (!shortcut) {
    hint.textContent = t('shortcutNone')
    return
  }
  hint.append(`${t('shortcut')} `)
  // macOS gives "⌥⇧E", the others "Alt+Shift+E".
  for (const key of shortcut.includes('+') ? shortcut.split('+') : [...shortcut]) {
    const kbd = document.createElement('kbd')
    kbd.textContent = key
    hint.append(kbd)
  }
}

function renderFremplay() {
  const share = session.share ?? null
  const here = Boolean(share) && share.tabId === tab?.id
  const elsewhere = Boolean(share) && !here

  $('ttitle').textContent = tab?.title ?? ''
  $('thost').textContent = hostOf(tab?.url)
  const icon = tab?.favIconUrl
  $('favicon').src = icon && /^(https?|data):/.test(icon) ? icon : 'icons/icon-16.png'

  $('live').hidden = !share
  $('livetext').textContent = here ? t('liveHere') : elsewhere ? t('liveElsewhere', share.meta?.title || share.meta?.host || '') : ''

  const canStart = video.checked && !video.restricted && Boolean(video.picked || video.askOrigin)
  const go = $('go')
  go.hidden = here
  go.disabled = busy || !canStart
  go.textContent = video.checked && !video.restricted && !canStart ? t('noVideo') : elsewhere ? t('sendInstead') : t('send')
  $('stop').hidden = !share
  $('stop').disabled = busy

  const askHost = video.askOrigin && !here ? hostOf(video.askOrigin) : null
  $('ask').hidden = !askHost
  $('ask').textContent = askHost ? t('askPlayer', askHost) : ''

  const error = shownError ? (ERRORS[shownError] ?? ERRORS.failed)() : video.restricted && !here ? t('errCapture') : null
  $('error').hidden = !error
  $('error').textContent = error ?? ''
}

function render() {
  const paired = Boolean(local.token)
  renderLink()
  $('menu').hidden = !paired
  $('pair').hidden = paired
  if (paired) renderFremplay()
  else renderPairing()
}

async function startHere() {
  const res = await ask('start', { tabId: tab.id })
  busy = false
  starting = false
  if (res?.ok) return window.close()
  shownError = res?.error ?? 'failed'
  ask('seen')
  render()
}

$('go').addEventListener('click', () => {
  if (busy || !tab) return
  busy = true
  starting = true
  shownError = null
  render()
  const origin = video.askOrigin
  if (!origin) return void startHere()
  // A player from another site: its permission is asked now, within the click. The browser's
  // prompt may close this popup, so the worker is told first and starts the share once granted.
  ask('expectGrant', { tabId: tab.id, origin })
  chrome.permissions.request({ origins: [`${origin}/*`] }).then(
    (granted) => {
      // Granted: the worker starts it, and the storage change tells this popup how it went.
      if (!granted) startHere()
    },
    () => startHere(),
  )
})

$('stop').addEventListener('click', async () => {
  busy = true
  render()
  await ask('stop')
  busy = false
  shownError = null
  render()
})

$('connect').addEventListener('click', async () => {
  busy = true
  render()
  await ask('pair')
  busy = false
  render()
})

$('settings').addEventListener('click', (e) => {
  e.preventDefault()
  chrome.runtime.openOptionsPage()
  window.close()
})

chrome.storage.onChanged.addListener((changes, area) => {
  const target = area === 'local' ? local : area === 'session' ? session : null
  if (!target) return
  for (const [key, { newValue }] of Object.entries(changes)) target[key] = newValue
  // A start the worker ran after a permission prompt: close on success, show its error otherwise.
  if (starting && session.share?.tabId === tab?.id && session.share?.accepted) return window.close()
  if (starting && area === 'session' && changes.lastError?.newValue) {
    busy = false
    starting = false
    shownError = changes.lastError.newValue
    ask('seen')
  }
  // Just paired: look at the tab for the menu.
  if (area === 'local' && changes.token?.newValue && !changes.token.oldValue) inspectTab().then(render)
  render()
})

async function main() {
  ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  local = await chrome.storage.local.get(null)
  session = await chrome.storage.session.get(null)
  if (session.lastError) {
    shownError = session.lastError
    ask('seen')
  }
  render()
  ask('open')
  // The pairing code counts down; the share's title changes under the menu.
  setInterval(() => !local.token && render(), 1000)
  const commands = await chrome.commands.getAll()
  renderShortcut(commands.find((c) => c.name === 'fremplay-toggle')?.shortcut)
  if (local.token) {
    await inspectTab()
    render()
  }
}

main().catch(() => {
  shownError = 'failed'
  render()
})
