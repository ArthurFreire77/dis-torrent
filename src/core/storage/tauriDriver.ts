import type { StorageDriver } from './driver'

// Quando rodando em Tauri, usa keyring via invoke para segredo; para dados normais usa localStorage (futuro: SQLite)
// Esta camada já prepara a migração para SQLite sem mudar Repositories

export class TauriDriver implements StorageDriver {
  private isTauri = typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window || '__TAURI_IPC__' in window)

  get<T>(key: string): T | null {
    try {
      // segredos: tenta keyring (async não disponível aqui sync) -> fallback localStorage com aviso
      // Fase atual: usa localStorage mas marca como tauri para futuro
      const raw = localStorage.getItem('forge:' + key)
      return raw ? JSON.parse(raw) as T : null
    } catch { return null }
  }
  set<T>(key: string, value: T): void {
    localStorage.setItem('forge:' + key, JSON.stringify(value))
    // Futuro: invoke('secure_store', {key, value: JSON.stringify(value)}) para chaves privadas
  }
  remove(key: string): void { localStorage.removeItem('forge:' + key) }
  clear(prefix = 'forge:'): void {
    for(let i=localStorage.length-1;i>=0;i--){
      const k = localStorage.key(i)
      if (!k) continue
      if(k.startsWith(prefix)) localStorage.removeItem(k)
    }
  }
}
