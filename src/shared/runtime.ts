// Detecção de plataforma — fonte ÚNICA.
//
// Antes cada módulo reinventava a checagem (`index.ts`, `appState.ts`,
// `fileSwarm.ts`, `sfx.ts`, `screenShare.ts`, `callManager.ts` e o wizard tinham
// 6 implementações). Além da duplicação, elas divergiam: umas checavam
// `__TAURI_IPC__`, outras só `__TAURI__`, e o wizard inline checava as três.
// Resultado: num build antigo do WebView o "modo navegador" era decidido de
// forma diferente por cada módulo e o app salvava arquivo no lugar errado.
//
// Regra: TODA decisão de plataforma passa por aqui. É módulo puro (sem Tauri,
// sem DOM obrigatório) para rodar no `node --test`.

type Win = Record<string, unknown>

/** Estamos dentro do runtime Tauri (IPC disponível)? */
export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as Win
  // v2 expõe __TAURI_INTERNALS__, v1 __TAURI__, builds antigos __TAURI_IPC__.
  return '__TAURI_INTERNALS__' in w || '__TAURI__' in w || '__TAURI_IPC__' in w
}

/** Android (WebView do Tauri ou navegador mobile). */
export function isAndroidRuntime(): boolean {
  try {
    if (typeof navigator === 'undefined') return false
    return /android/i.test(navigator.userAgent ?? '')
  } catch {
    return false
  }
}

/** Tauri rodando no Android — o único caminho confiável de download é o nativo. */
export function isTauriAndroid(): boolean {
  return isTauriRuntime() && isAndroidRuntime()
}

/** iOS/iPadOS (inclui iPad que se identifica como Macintosh com toque). */
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

/** Estamos num navegador puro (modo web, sem core)? */
export function isBrowserOnly(): boolean {
  return !isTauriRuntime()
}
