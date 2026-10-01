// Utilidades de performance (sem dependências): coalescing/throttle de refreshes.
// Visual FORGE inalterado — só reduzem a frequência de setState/re-render.
//
// Gargalos que motivaram:
// - refreshFriends a cada 3s (polling) + 1x por evento + 1x por ação do usuário
//   = N refreshes redundantes (cada um = 3 chamadas friendsList + 3 setState).
// - fileSwarm.onChange dispara 1 setState por chunk de 256KB recebido
//   (com 4 chunks em paralelo = tempestade de re-renders da árvore inteira).
// - listas (conversas/amigos/mensagens) com filter/map/sort refeitos a cada
//   render — inclusive a cada tecla digitada no composer.

export type Cancellable = (() => void) & { cancel: () => void }

/**
 * Throttle com trailing para callbacks síncronos (ex.: fileSwarm.onChange).
 * Garante no máximo 1 execução por `windowMs`, sem perder a última chamada
 * (a trailing executa ao fim da janela). Chamadas extras dentro da janela são
 * absorvidas (coalescidas).
 */
export function throttleTrailing(fn: () => void, windowMs: number): Cancellable {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const wrapped = (() => {
    const now = Date.now()
    const elapsed = now - last
    if (elapsed >= windowMs && timer === null) {
      last = now
      fn()
      return
    }
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        fn()
      }, Math.max(0, windowMs - elapsed))
    }
    // trailing já agendado: esta chamada é absorvida
  }) as Cancellable
  wrapped.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  return wrapped
}

/**
 * Coalescing para refreshes assíncronos (ex.: refreshFriends).
 * - Leading imediato: a primeira chamada executa na hora (preserva o sync
 *   ao vivo — testes live.spec/files.spec têm timeout de 15s).
 * - Chamadas redundantes dentro de `minIntervalMs` colapsam numa única
 *   execução trailing (no máximo 1 refresh por janela).
 * - Nunca sobrepõe execuções em voo: se chegar chamada durante o voo, marca
 *   pending e re-executa uma vez ao final (dados nunca ficam obsoletos).
 * - Aba oculta (WebView em background): adia a execução — polling/eventos
 *   repetem ao voltar, sem gastar bateria/CPU em background.
 */
export function coalesceAsyncRefresh(fn: () => Promise<void>, minIntervalMs: number): Cancellable {
  let lastRun = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let queued = false

  const schedule = (delayMs: number) => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      run()
    }, Math.max(0, delayMs))
  }
  const run = () => {
    lastRun = Date.now()
    inFlight = true
    void Promise.resolve()
      .then(fn)
      .catch(() => {
        // refresh nunca deve quebrar a UI
      })
      .finally(() => {
        inFlight = false
        if (queued) {
          queued = false
          schedule(0)
        }
      })
  }
  const wrapped = (() => {
    if (inFlight) {
      queued = true
      return
    }
    if (typeof document !== 'undefined' && document.hidden) {
      schedule(minIntervalMs)
      return
    }
    const elapsed = Date.now() - lastRun
    if (elapsed >= minIntervalMs && timer === null) run()
    else schedule(minIntervalMs - elapsed)
  }) as Cancellable
  wrapped.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    queued = false
  }
  return wrapped
}
