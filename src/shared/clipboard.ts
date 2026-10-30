// Área de transferência — fonte ÚNICA.
//
// Existiam duas implementações: `copyBestEffort` (BotConfigPanel, silenciosa, só
// `navigator.clipboard` + `.catch(() => {})`) e `copyText`/`readClipboard`
// (ServerHub, com fallback para WebView antigo e mensagem de erro detalhada).
// O resultado eram telas que diziam "copiado" sem ter copiado (a primeira) e
// outras que copiavam e não avisavam (a segunda).
//
// Contrato: devolver `true` SÓ quando a cópia realmente aconteceu. Quem chama
// decide o que mostrar.

/**
 * Copia texto. Tenta a Clipboard API (exige contexto seguro/gesto) e, se ela
 * não existir ou for negada, cai no `execCommand('copy')` do WebView antigo.
 */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text ?? '')
  if (!value) return false

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    /* permissão negada ou contexto inseguro — tenta o fallback legado */
  }

  try {
    // WebViewGTK 2.0 (Linux) não tem Clipboard API em contexto não seguro.
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

/**
 * Copia sem esperar resposta (para handlers de clique que não mostram aviso).
 * A promessa nunca rejeita — o chamador não precisa de `try`.
 */
export function copyBestEffort(text: string): void {
  void copyText(text).catch(() => {})
}

export type ClipboardRead = { ok: true; text: string } | { ok: false; reason: string }

/**
 * Lê a área de transferência. `readText` exige HTTPS + gesto do usuário e pode
 * ser negado; devolvemos o motivo em pt-BR para a UI explicar em vez de fingir.
 * O texto vem com `trim()` e caixa vazia é recusada — colar "nada" num campo de
 * convite só produz um erro confuso depois.
 */
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
