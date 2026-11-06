import { services } from './index'
import type { UpdateDeps, UpdateInfo } from './updateRules'

export * from './updateRules'

/** Estados de confiança de build (espelham o enum do Rust). */
export type PeerTrustState =
  | 'NAO_VERIFICADO'
  | 'RELEASE_VERIFICADA'
  | 'ATESTACAO_DE_HARDWARE'
  | 'REVOGADO'
  | 'OBSOLETO'

export interface PeerTrustInfo {
  fp: string
  state: PeerTrustState
  version: string
  manifest_hash: string
  build_id: string
  commit: string
  channel: string
  valid_signatures: number
  self_integrity: 'CONFERE' | 'DIVERGE' | 'UNAVAILABLE'
  hardware_proof: boolean
  hardware_reason: string
  reason: string
  verification_available: boolean
  quarantined: boolean
  quarantine_reason: string
}

export interface PendingUpdate {
  asset_name: string
  sha256: string
  size: number
  version: string
  manifest_hash: string
  security_epoch: number
  path: string
}

export interface PeerTrustPolicyInfo {
  policy: string
  policies: string[]
}

export interface TrustInfo {  verification_available: boolean
  unavailable_reason: string
  epoch_floor: number
  trust_epoch: number
  threshold: number
  keys: { key_id: string; pubkey_hex: string }[]
  revoked_versions: string[]
  latest_verified: {
    version: string
    manifest_hash: string
    security_epoch: number
    valid_signatures: number
    trust_epoch: number
  } | null
}

export function nativeUpdateDeps(): UpdateDeps | null {
  if (services.kind !== 'native') return null
  const s = services as unknown as {
    updateCheck?: () => Promise<UpdateInfo>
    updateDownload?: (name: string) => Promise<string>
    updateApply?: (path: string) => Promise<void>
    updateFlagGet?: (key: string) => Promise<string | null>
    updateFlagSet?: (key: string, value: string) => Promise<void>
    appQuit: () => Promise<void>
  }
  if (!s.updateCheck || !s.updateDownload || !s.updateApply) return null
  return {
    check: () => s.updateCheck!(),
    // O nome do asset é o único campo que vem da UI; URL, hash e tamanho saem
    // do manifesto verificado no Rust. Um nome trocado é recusado lá.
    download: (info) => s.updateDownload!(info.asset_name),
    apply: async (path) => {
      if (/android/i.test(navigator.userAgent ?? '')) {
        // No Android o Rust já validou hash+manifesto e devolveu o sinal de
        // "instalar"; o plugin nativo confere a assinatura do APK e abre o
        // instalador do sistema (consentimento do usuário é obrigatório).
        const { invoke } = await import('@tauri-apps/api/core')
        try {
          await invoke('update_apply', { path })
        } catch (e) {
          const msg = String((e as Error)?.message ?? e)
          if (!msg.includes('INSTALAR_APK_VALIDADO')) throw e
        }
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
