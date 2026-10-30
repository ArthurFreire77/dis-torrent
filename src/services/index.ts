import type { DisTorrentServices } from './models'
import { tauriServices } from './tauri'
import { browserServices } from './browser'
import { isTauriRuntime } from '../shared/runtime.ts'

// Escolhe o backend de serviços (IPC nativo × simulação no navegador).
// A detecção de runtime mora em `shared/runtime.ts` — esta era a primeira das
// seis cópias e divergia das outras em qual flag global checava.
export const services: DisTorrentServices = isTauriRuntime() ? tauriServices : browserServices

export * from './models'
