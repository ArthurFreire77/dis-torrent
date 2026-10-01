import type { StorageDriver } from './driver'

const PREFIX = 'forge:'

export class SessionDriver implements StorageDriver {
  get<T>(key: string): T | null {
    try {
      const raw = sessionStorage.getItem(PREFIX + key)
      return raw ? (JSON.parse(raw) as T) : null
    } catch { return null }
  }
  set<T>(key: string, value: T): void {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value))
  }
  remove(key: string): void { sessionStorage.removeItem(PREFIX + key) }
  clear(prefix = PREFIX): void {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (!k) continue
      if (k.startsWith(prefix)) sessionStorage.removeItem(k)
    }
  }
}
