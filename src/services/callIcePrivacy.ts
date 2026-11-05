export type CallPrivacyMode = 'normal' | 'encrypted' | 'proxy' | 'full'

export function getCallPrivacyMode(): CallPrivacyMode | null {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem('distorrent:privacy_mode') : null
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    return v === 'normal' || v === 'encrypted' || v === 'proxy' || v === 'full' ? v : null
  } catch {
    return null
  }
}

let callPrivacyOverride: CallPrivacyMode | null = null

export function setCallPrivacyForIce(mode: CallPrivacyMode | null): void {
  callPrivacyOverride = mode
}

export function getCallPrivacyForIce(): CallPrivacyMode | null {
  return callPrivacyOverride ?? getCallPrivacyMode()
}

export function isIcePublicFallbackSuppressed(): boolean {
  const m = getCallPrivacyForIce()
  return m === 'proxy' || m === 'full'
}
