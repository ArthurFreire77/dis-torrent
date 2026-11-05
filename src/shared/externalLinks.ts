const EXTERNAL_SCHEMES = ['http:', 'https:', 'mailto:', 'distorrent:']

export function isExternalUrl(href: string, appOrigin: string): boolean {
  const raw = (href ?? '').trim()
  if (!raw) return false
  if (raw.startsWith('#') || raw.startsWith('/') || raw.startsWith('?')) return false
  let url: URL
  try {
    url = new URL(raw, appOrigin || 'http://localhost')
  } catch {
    return false
  }
  if (!EXTERNAL_SCHEMES.includes(url.protocol)) return false
  if (url.protocol === 'distorrent:') return true
  let origem = ''
  try {
    origem = new URL(appOrigin).origin
  } catch {
    return true
  }
  return url.origin !== origem
}

export function isDeepLinkUrl(href: string): boolean {
  try {
    const p = new URL((href ?? '').trim()).protocol
    return p !== 'http:' && p !== 'https:'
  } catch {
    return false
  }
}

export function canOpenExternally(href: string): boolean {
  try {
    return EXTERNAL_SCHEMES.includes(new URL((href ?? '').trim()).protocol)
  } catch {
    return false
  }
}
