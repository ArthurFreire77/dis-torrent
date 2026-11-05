type Win = Record<string, unknown>

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as Win
  return '__TAURI_INTERNALS__' in w || '__TAURI__' in w || '__TAURI_IPC__' in w
}

export function isAndroidRuntime(): boolean {
  try {
    if (typeof navigator === 'undefined') return false
    return /android/i.test(navigator.userAgent ?? '')
  } catch {
    return false
  }
}

export function isTauriAndroid(): boolean {
  return isTauriRuntime() && isAndroidRuntime()
}

export function isIOSRuntime(): boolean {
  try {
    if (typeof navigator === 'undefined') return false
    const ua = String(navigator.userAgent ?? '')
    if (/iPhone|iPad|iPod/i.test(ua)) return true
    const touch = (navigator as unknown as { maxTouchPoints?: number }).maxTouchPoints ?? 0
    return /Macintosh/i.test(ua) && touch > 1
  } catch {
    return false
  }
}

export function isBrowserOnly(): boolean {
  return !isTauriRuntime()
}

export function isWindowsRuntime(): boolean {
  try {
    if (typeof navigator === 'undefined') return false
    const ua = String(navigator.userAgent ?? '')
    return /Windows NT/i.test(ua) && !/Android/i.test(ua)
  } catch {
    return false
  }
}
