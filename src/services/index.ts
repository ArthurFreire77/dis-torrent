import type { DisTorrentServices } from './models'
import { tauriServices } from './tauri'
import { browserServices } from './browser'
import { isTauriRuntime } from '../shared/runtime.ts'

export const services: DisTorrentServices = isTauriRuntime() ? tauriServices : browserServices

export * from './models'
