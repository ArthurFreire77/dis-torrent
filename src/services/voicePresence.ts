// voicePresence — QUEM realmente está no canal (filtro puro, testável).
//
// ## O problema que isto resolve
//
// `voice_states` é uma tabela PERSISTENTE do SQLite: uma linha só sai quando o
// `VoiceLeave` chega. Quem fecha o app, trava ou cai sem desligar deixa a linha
// para sempre. O resultado apareceu no print do dono: um usuário "segura" na
// chamada que não estava lá — e pior, o `joinVoice` abria par com um
// fingerprint morto e a tela ficava em "Conectando…" eterno.
//
// O core já limpa no `PeerOffline` quando a rota morre, mas isso depende do
// evento chegar. Aqui a UI aplica a regra que ela consegue provar sozinha:
// **quem está na voz e não está online é fantasma** (salvo eu mesma, que posso
// entrar sem ter sessão com ninguém).

export interface VoiceRow {
  fp: string
  muted: boolean
  deafened: boolean
}

export interface PresencaFiltro {
  /** Meu fingerprint (nunca é removido por este filtro). */
  myFp: string
  /** fps com sessão viva AGORA (`peers` do motor com estado CONNECTED). */
  onlineFps: ReadonlySet<string>
  /**
   * Considera online só o que está no conjunto?
   *
   * `false` durante a fase em que o motor ainda não reportou ninguém (boot,
   * reconexão geral): filtrar aí esconderia TODO MUNDO e a chamada pareceria
   * vazia. Sem essa saída o remédio (esconder fantasma) viraria a doença.
   */
  filtrar?: boolean
}

/**
 * Devolve só quem pode estar na chamada de verdade.
 *
 * Regra: eu sempre fico; dos outros, só quem está online agora. A ordem é
 * preservada (eu primeiro é responsabilidade de quem chama a UI).
 */
export function filterLiveVoiceRows(rows: VoiceRow[], filtro: PresencaFiltro): VoiceRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return []
  if (filtro.filtrar === false) return rows.slice()
  const meu = filtro.myFp ?? ''
  return rows.filter((r) => {
    if (!r?.fp) return false
    // Eu: mantenho mesmo sem sessão online (canal vazio, ninguém pareado).
    if (meu && r.fp === meu) return true
    return filtro.onlineFps.has(r.fp)
  })
}

/**
 * `true` quando o motor já sabe de alguém (ou de mim) naquele canal.
 *
 * Serve para decidir se vale a pena esconder fantasmas: se a lista veio com
 * gente e NENHUM está online, muito provavelmente são todos linhas velhas.
 */
export function temAlguemVivo(rows: VoiceRow[], myFp: string, onlineFps: ReadonlySet<string>): boolean {
  return rows.some((r) => !!r.fp && (r.fp === myFp || onlineFps.has(r.fp)))
}

/** Contagem para rótulos ("2 pessoas na chamada"), sem contar fantasmas. */
export function contarNaChamada(rows: VoiceRow[], filtro: PresencaFiltro): number {
  return filterLiveVoiceRows(rows, filtro).length
}
