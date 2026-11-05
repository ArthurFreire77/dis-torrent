export async function copyText(text: string): Promise<boolean> {
  const value = String(text ?? '')
  if (!value) return false

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {}

  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function copyBestEffort(text: string): void {
  void copyText(text).catch(() => {})
}

export type ClipboardRead = { ok: true; text: string } | { ok: false; reason: string }

export async function readClipboard(): Promise<ClipboardRead> {
  try {
    if (!navigator.clipboard?.readText) {
      return {
        ok: false,
        reason:
          'este WebView não expõe leitura da área de transferência — cole com o botão de colar do sistema',
      }
    }
    const text = await navigator.clipboard.readText()
    if (!text || !text.trim()) return { ok: false, reason: 'a área de transferência está vazia' }
    return { ok: true, text: text.trim() }
  } catch (e) {
    return {
      ok: false,
      reason: `não foi possível ler a área de transferência (${String(
        (e as Error)?.message ?? e,
      )}) — cole manualmente no campo`,
    }
  }
}
