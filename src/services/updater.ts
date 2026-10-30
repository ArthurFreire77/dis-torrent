// ORQUESTRAÇÃO DA ATUALIZAÇÃO (fala com o `services` nativo).
//
// As REGRAS (comparar versão, decidir, fluxo) moram em `updateRules.ts`, que é
// puro e testável em Node. Este arquivo só liga as regras ao `services`, e é
// importado APENAS por componentes/UI (que já vivem no Tauri).
//
// PROBLEMA QUE ISTO RESOLVE: o usuário ficava semanas numa build antiga com bug
// de chamada de voz porque a versão nova exigia abrir o GitHub e baixar à mão.
// Pior: protocolo P2P diferente entre versões degrada a rede inteira. Agora o
// app procura a release mais nova ANTES de entrar e, quando pode, instala e
// reabre sozinho (Windows).

import { services } from './index'
import type { UpdateDeps, UpdateInfo } from './updateRules'

export * from './updateRules'

/** Fábrica de deps sobre o `services` nativo. Fora do Tauri devolve `null`. */
export function nativeUpdateDeps(): UpdateDeps | null {
  if (services.kind !== 'native') return null
  const s = services as unknown as {
    updateCheck?: () => Promise<UpdateInfo>
    updateDownload?: (url: string, name: string, digest: string) => Promise<string>
    updateApply?: (path: string) => Promise<void>
    updateFlagGet?: (key: string) => Promise<string | null>
    updateFlagSet?: (key: string, value: string) => Promise<void>
    appQuit: () => Promise<void>
  }
  if (!s.updateCheck || !s.updateDownload || !s.updateApply) return null
  return {
    check: () => s.updateCheck!(),
    download: (info) => s.updateDownload!(info.download_url, info.asset_name, info.digest),
    apply: async (path) => {
      // ANDROID: quem abre o instalador é o plugin Kotlin (`updater|installApk`),
      // porque desde o Android 7 o APK precisa sair por `content://` (FileProvider)
      // e desde o 8 exige REQUEST_INSTALL_PACKAGES. O Rust só baixa e confere o
      // hash; chamar `update_apply` aqui devolveria erro.
      if (/android/i.test(navigator.userAgent ?? '')) {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('plugin:updater|installApk', { path })
        return
      }
      await s.updateApply!(path)
    },
    quit: () => s.appQuit(),
    // Flags vivem no kv do SQLite (mesmo lugar das outras preferências).
    // Falha de leitura devolve `null` — nunca inventa "já pulei".
    getFlag: async (key) => {
      try {
        return (await s.updateFlagGet?.(key)) ?? null
      } catch {
        return null
      }
    },
    setFlag: async (key, value) => {
      try {
        await s.updateFlagSet?.(key, value)
      } catch {
        /* preferência é conveniência: perder não pode quebrar o boot */
      }
    },
  }
}
