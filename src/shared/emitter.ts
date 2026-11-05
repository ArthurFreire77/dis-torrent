export type Unsubscribe = () => void

export interface Emitter<T> {
  subscribe(cb: (value: T) => void): Unsubscribe
  emit(value: T): void
  size(): number
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
      for (const handler of [...handlers]) {
        try {
          handler(value)
        } catch (err) {
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
