// COMPATIBILIDADE ENTRE VERSÕES DO APP.
//
// ## O problema que isto resolve
//
// Pedido do dono: "eu tô na 1.47 e meu amigo na 1.43 — ele deve conseguir
// conectar. Cinco versões de distância tem que funcionar, em chamada e tudo.
// Depois de cinco, não tem tanto problema."
//
// O protocolo já tem `proto_v` no handshake, mas isso só cobre o TRANSPORTE.
// O que quebra entre versões do APP são os FRAMES e os CAMPOS novos:
//
//   - `SecureFrame` é um enum serde "externally tagged": receber uma variante
//     que não existe no binário antigo faz o `from_slice` FALHAR e a sessão
//     inteira cai. Um peer novo mandando `VoiceVideoFrame` para um de 1.43
//     derrubava a conexão em vez de simplesmente ignorar o frame.
//   - Campos novos sem `#[serde(default)]` falham ao desserializar.
//
// Regra da casa: **um recurso novo nunca pode ser obrigatório para a sessão
// existir**. Quem não sabe fazer X continua conversando por texto/voz.
//
// ## O que é "versão de app" aqui
//
// A compatibilidade é medida em RELEASES (1.1.44, 1.1.45, ...), não em
// `proto_v`: o dono pensa em versões do app. `PROTO_V` continua sendo o gate do
// transporte (Punch, túnel), que é outra coisa e muda muito menos.

/** Quantas releases de distância ainda precisam conversar. */
export const JANELA_COMPAT = 5

/**
 * Compara duas versões do app no formato `1.1.47-pre-alpha`.
 *
 * Devolve a DISTÂNCIA em releases (número de versões entre elas), não o sinal:
 * `1.1.47` e `1.1.44` estão a 3 de distância. Como o patch é sequencial neste
 * projeto, a distância é a diferença do último componente quando major/minor
 * são iguais; se mudarem, considera "muito longe" (fora da janela).
 */
export function distanciaEntreVersoes(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return Number.POSITIVE_INFINITY
  if (pa.major !== pb.major || pa.minor !== pb.minor) {
    // Major/minor diferente: mudança grande, trate como fora da janela.
    return Math.abs(pa.major - pb.major) * 1000 + Math.abs(pa.minor - pb.minor) * 100
  }
  return Math.abs(pa.patch - pb.patch)
}

interface Versao {
  major: number
  minor: number
  patch: number
}

function parse(raw: string): Versao | null {
  const s = String(raw ?? '').trim().replace(/^v/i, '')
  const core = s.split('-')[0] ?? ''
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(core)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/**
 * As duas versões conseguem conversar? (dentro da janela de 5 releases)
 *
 * Versão desconhecida/ilegível conta como COMPATÍVEL: é melhor tentar e falhar
 * com erro honesto do que recusar conexão por não saber ler o número.
 */
export function versoesCompativeis(minha: string, dele: string): boolean {
  const d = distanciaEntreVersoes(minha, dele)
  if (!Number.isFinite(d)) return true
  return d <= JANELA_COMPAT
}

/** Texto honesto para a UI quando está fora da janela. */
export function avisoForaDaJanela(minha: string, dele: string): string | null {
  if (versoesCompativeis(minha, dele)) return null
  return `as versões estão muito distantes (a sua ${minha || '?'} e a dele ${dele || '?'}); `
    + `atualize os dois lados para conversar — até ${JANELA_COMPAT} versões de diferença funciona`
}

// ── Frames: o que pode ser enviado para cada versão ────────────────────────

/**
 * Recursos que dependem de frame novo. Cada um tem a versão MÍNIMA do app que
 * entende o frame.
 *
 * QUEM ADICIONA UM FRAME NOVO AQUI evita o bug real: mandar o frame para um
 * peer antigo derrubava a sessão inteira no `from_slice` (o enum não conhece a
 * variante). O gate é sempre "o OUTRO lado sabe?".
 */
export const RECURSO_MIN_VERSAO = {
  /** `VoiceVideoFrame` (quadro JPEG da câmera/tela no caminho nativo). */
  voiceVideoFrame: '1.1.40',
  /** `VoiceStats` (métricas da mídia nativa). */
  voiceStats: '1.1.40',
  /** `Read` (visto azul) — proto_v>=4, mas o app só passou a enviar na 1.1.30. */
  reciboLeitura: '1.1.30',
} as const

export type RecursoGated = keyof typeof RECURSO_MIN_VERSAO

/**
 * Posso usar este recurso com um peer nesta versão?
 *
 * `dele` vazio (handshake antigo sem versão de app) = NÃO: o lado antigo não
 * declarou capacidade, então não se arrisca derrubar a sessão.
 */
export function podeUsarRecurso(recurso: RecursoGated, dele: string): boolean {
  const min = RECURSO_MIN_VERSAO[recurso]
  if (!dele) return false
  const d = parse(dele)
  const m = parse(min)
  if (!d || !m) return false
  if (d.major !== m.major) return d.major > m.major
  if (d.minor !== m.minor) return d.minor > m.minor
  return d.patch >= m.patch
}
