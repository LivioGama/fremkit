// The message key the popup shows for each error a start or a share can end with (`lastError`),
// and what it shows while Fremkit says Fremplay is off. The worker stores the codes; only the
// popup turns them into words, in the browser's language (_locales).

export const SHARE_ERRORS = {
  noVideo: 'noVideo',
  noWidget: 'errNoWidget',
  disabled: 'errDisabled',
  offerRefused: 'errOfferRefused',
  protocol: 'errProtocol',
  unreachable: 'errUnreachable',
  capture: 'errCapture',
  unpaired: 'errUnpaired',
  noVideoLeft: 'errNoVideoLeft',
  needsPermission: 'errNeedsPermission',
  failed: 'errFailed',
}

/** The message key for an error code; an unknown one reads as a plain failure. */
export function shareErrorKey(code) {
  return Object.hasOwn(SHARE_ERRORS, code) ? SHARE_ERRORS[code] : SHARE_ERRORS.failed
}

/**
 * What the Fremplay card says before anything is tried, and whether Send is greyed: Fremkit said
 * Fremplay is off (`fremplayOff`, from its `ready` or a `disabled` refusal). Null otherwise.
 */
export function fremplayBlocked(session) {
  return session?.fremplayOff === true ? { error: 'disabled', key: SHARE_ERRORS.disabled } : null
}
