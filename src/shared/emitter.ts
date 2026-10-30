// Emissor de eventos tipado — fonte ÚNICA do padrão `subscribe → Set<handler>`.
//
// Seis módulos (`appState`, `browser`, `deepLink`, `notifications`,
// `downloadManager`, `diagLog`) repetiam o mesmo par `Set` + laço com `try`.
// A repetição custou caro duas vezes: (1) cada cópia escolhia por conta própria
// se um handler que lança derruba os outros — em `browser.ts` derrubava;
// (2) a limpeza de inscrição era feita em closure anônima, e um `unsubscribe`
// chamado duas vezes (StrictMode do React faz isso) quebrava o contador.
//
// Contrato: entregar para TODOS, isolar falha de um handler, e devolver uma
// função de cancelamento idempotente.

export type Unsubscribe = () => void

export interface Emitter<T> {
  /** Inscreve. Chamar o retorno mais de uma vez não faz nada na segunda. */
  subscribe(cb: (value: T) => void): Unsubscribe
  /** Entrega o valor a todos os inscritos agora. */
  emit(value: T): void
  /** Quantos inscritos existem (diagnóstico/teste). */
  size(): number
  /** Descarta todos os inscritos (desmontagem do app, testes). */
  clear(): void
}

export function createEmitter<T>(onError?: (err: unknown) => void): Emitter<T> {
  const handlers = new Set<(value: T) => void>()

  return {
    subscribe(cb) {
      if (typeof cb !== 'function') return () => {}
      handlers.add(cb)
      let active = true
      return () => {
        if (!active) return
        active = false
        handlers.delete(cb)
      }
    },
    emit(value) {
      // Copia a lista: um handler pode cancelar a própria inscrição (ou a de
      // outro) durante a entrega, e mutar o Set no meio do `for..of` pularia
      // handlers silenciosamente.
      for (const handler of [...handlers]) {
        try {
          handler(value)
        } catch (err) {
          // Um handler quebrado não pode impedir os demais — era exatamente o
          // bug de "notificação chega para um painel e não para o outro".
          onError?.(err)
        }
      }
    },
    size() {
      return handlers.size
    },
    clear() {
      handlers.clear()
    },
  }
}
