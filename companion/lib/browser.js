// What the extension calls the browser it runs in, for the pairing request: the name the user
// then sees on the Edge and in Appareils. Chromium browsers share one extension, so the brand
// list of `navigator.userAgentData` is what tells them apart.

const NAMES = [
  [/edge/i, 'Edge'],
  [/opera/i, 'Opera'],
  [/brave/i, 'Brave'],
  [/vivaldi/i, 'Vivaldi'],
  [/^arc$/i, 'Arc'],
  [/google chrome/i, 'Chrome'],
]

/** A short browser name from `navigator.userAgentData.brands`, `Chromium` when none is known. */
export function browserName(brands) {
  for (const [re, name] of NAMES) if ((brands ?? []).some((b) => re.test(b?.brand ?? ''))) return name
  return 'Chromium'
}
