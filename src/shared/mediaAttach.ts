// Anexa MediaStream a <audio>/<video> e GARANTE que a mídia toca.
//
// ## Por que isto existe
//
// `autoPlay` não basta. No WebView do Android (e no Safari/iOS) o elemento
// com `srcObject = MediaStream` só começa a tocar quando alguém chama
// `play()` — e como o stream remoto chega *depois* do gesto do usuário
// (atender a chamada), a política de autoplay volta a valer. Resultado no
// celular: a chamada "conecta", o badge diz "Conectado", e não sai som
// nenhum — o defeito mais confuso que existe, porque nada acusa erro.
//
// A ordem abaixo é a que funciona nos dois:
//   1. `srcObject` (idempotente — não reatribui o mesmo stream);
//   2. `play()` explícito, com retentativas escalonadas;
//   3. se tudo for bloqueado, um único listener no primeiro toque/tecla do
//      usuario desarma o problema: o toque que VAI chamar o play().
//
// O desktop já chamava `play()` no áudio (mas não no vídeo) e o mobile não
// chamava em nenhum dos dois. Uma função só, usada pelas duas UIs.

type MediaEl = HTMLAudioElement | HTMLVideoElement

/** Retentativa do play(): 250ms → 1s → 3s. Cobre a maioria dos casos em que
 *  o stream chega logo depois do gesto de atender. */
const RETRY_DELAYS_MS = [250, 1000, 3000]

/** Listeners de "primeiro gesto" já instalados (um por elemento). */
const pendingGestureRetry = new WeakMap<MediaEl, () => void>()

function onFirstGesture(el: MediaEl, retry: () => void) {
  const events = ['pointerdown', 'touchstart', 'keydown', 'click'] as const
  const done = () => {
    for (const e of events) window.removeEventListener(e, done, true)
    pendingGestureRetry.delete(el)
    retry()
  }
  // capture=true: pega o gesto antes de qualquer stopPropagation do app.
  for (const e of events) window.addEventListener(e, done, true)
  pendingGestureRetry.set(el, done)
}

/**
 * Prende o stream no elemento e toca. Seguro para chamar em todo render —
 * reatribuir o mesmo `srcObject` reiniciaria a reprodução.
 */
export function attachStream(el: MediaEl | null, stream: MediaStream | null | undefined): void {
  if (!el || !stream) return
  try {
    if (el.srcObject !== stream) el.srcObject = stream
  } catch { /* browser sem srcObject (muito antigo) */ }

  const attempt = (n: number) => {
    if (el.srcObject !== stream) return // componente trocou de stream: para
    void Promise.resolve(el.play?.())
      .then(() => { /* tocando */ })
      .catch(() => {
        if (n < RETRY_DELAYS_MS.length) {
          window.setTimeout(() => attempt(n + 1), RETRY_DELAYS_MS[n])
        } else if (!pendingGestureRetry.has(el)) {
          // Último recurso: política de autoplay barrou mesmo assim. Fica
          // esperando o próximo toque do usuário para destravar.
          onFirstGesture(el, () => { void el.play?.().catch(() => {}) })
        }
      })
  }
  attempt(0)
}

/** Cancelar o "primeiro gesto" pendente quando o componente desmonta. */
export function detachStream(el: MediaEl | null): void {
  if (!el) return
  const done = pendingGestureRetry.get(el)
  if (done) {
    for (const e of ['pointerdown', 'touchstart', 'keydown', 'click'] as const) {
      window.removeEventListener(e, done, true)
    }
    pendingGestureRetry.delete(el)
  }
}
