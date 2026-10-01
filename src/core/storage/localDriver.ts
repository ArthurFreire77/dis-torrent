import type { StorageDriver } from './driver'

const PREFIX = 'forge:'

export class LocalDriver implements StorageDriver {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(PREFIX + key)
      return raw ? JSON.parse(raw) as T : null
    } catch { return null }
  }
  set<T>(key: string, value: T): void {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  }
  remove(key: string): void { localStorage.removeItem(PREFIX + key) }
  clear(prefix = PREFIX): void {
    for(let i=localStorage.length-1;i>=0;i--){
      const k = localStorage.key(i)
      if (!k) continue
      if(k.startsWith(prefix)) localStorage.removeItem(k)
    }
  }
}
