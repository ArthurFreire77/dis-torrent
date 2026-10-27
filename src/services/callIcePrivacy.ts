// Privacidade × ICE — modo de privacidade do app regendo a lista de
// SERVIDORES STUN/TURN da chamada.
//
// POR QUÊ UM MÓDULO PRÓPRIO (padrão do callWire.ts): callManager importa a
// árvore de services (localStorage/@tauri) e não é carregável pelo runner de
// testes unit (node strip-types); este arquivo é AUTOCONTIDO e testável.
// O callManager reexporta tudo — shells continuam importando de lá.

/** Modos de privacidade do app (espelha `privacy.mode` do core Rust). */
export type CallPrivacyMode = 'normal' | 'encrypted' | 'proxy' | 'full'

/**
 * Lê o modo de privacidade de forma síncrona — só existe no MODO BROWSER,
 * onde fica em localStorage `forge:privacy_mode`. No app nativo (Tauri) o
 * modo vive no backend Rust (async `privacyGet`) e NÃO é legível aqui;
 * quem informa é a UI via `setCallPrivacyForIce` (boot + trocas).
 */
export function getCallPrivacyMode(): CallPrivacyMode | null {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem('forge:privacy_mode') : null
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    return v === 'normal' || v === 'encrypted' || v === 'proxy' || v === 'full' ? v : null
  } catch {
    return null
  }
}

// ── Privacidade × ICE (correção do vazamento de STUN público) ────────────────
//
// PROBLEMA REAL que isto corrige: a lista de ICE sempre incluía os SERVIDORES
// PÚBLICOS de reserva (Google STUN, openrelay TURN) — INCLUSIVE em proxy/Tor.
// O ICE do WebRTC não passa pelo SOCKS5 do app (sockets UDP do browser), então
// nesses modos cada chamada entregava o IP real a terceiros que o modo
// promete esconder — e a UI apresentava o modo como plenamente ativo.
//
// Comportamento NOVO (honesto):
// - normal/encrypted: lista completa como sempre (rotas de reserva no 4G).
// - proxy/full: SÓ o TURN/STUN que o usuário configurou EXPLICITAMENTE
//   (forge:turn_url / VITE_TURN_URL — escolha dele, servidor dele). Os
//   públicos de terceiros NÃO são consultados. A chamada continua
//   possível na LAN (candidatos host), e o aviso "não anônima" fica na UI.

/** Modo vigente injetado pela UI (nativa/Tauri). `null` = não injetado. */
let callPrivacyOverride: CallPrivacyMode | null = null

/** UI nativa informa o modo de privacidade atual (boot + trocas de modo). */
export function setCallPrivacyForIce(mode: CallPrivacyMode | null): void {
  callPrivacyOverride = mode
}

/** Modo que rege o ICE agora (override da UI > localStorage > null). */
export function getCallPrivacyForIce(): CallPrivacyMode | null {
  return callPrivacyOverride ?? getCallPrivacyMode()
}

/** Modo anônimo exige suprimir os SERVIDORES PÚBLICOS de ICE? */
export function isIcePublicFallbackSuppressed(): boolean {
  const m = getCallPrivacyForIce()
  return m === 'proxy' || m === 'full'
}
