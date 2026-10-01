import type { ForgeServices } from './models'
import { tauriServices } from './tauri'
import { browserServices } from './browser'

// Detecta runtime Tauri (IPC disponível) vs navegador puro.
// Tauri v2 expõe __TAURI_INTERNALS__, v1 expõe __TAURI__ — checa ambos para robustez
function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as Record<string, unknown>
  return '__TAURI_INTERNALS__' in w || '__TAURI__' in w || '__TAURI_IPC__' in w
}
export const services: ForgeServices = isTauriRuntime() ? tauriServices : browserServices

export * from './models'
