import { services } from './index'
import type { UpdateDeps, UpdateInfo } from './updateRules'

export * from './updateRules'

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
      if (/android/i.test(navigator.userAgent ?? '')) {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('plugin:updater|installApk', { path })
        return
      }
      await s.updateApply!(path)
    },
    quit: () => s.appQuit(),
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
      } catch {}
    },
  }
}
