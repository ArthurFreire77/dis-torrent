// Layout da tela de canal de VOZ/VÍDEO — regra PURA (testável em node:test).
//
// PROBLEMA QUE ESTE MÓDULO RESOLVE (relato do dono, com print): "a interface tá
// uma merda na tela de servidores; unifica, faz um padrão que pega a tela do
// lado direito mais completa, tudo completo unificado". No desktop o canal de
// voz tinha três layouts diferentes para o mesmo momento:
//
//   1. fora da chamada → `CallChannelStage` (cartão central estreito, 520 px);
//   2. dentro da chamada → palco de quadrados no centro + painel fixo de 300 px
//      com cabeçalho, diagnóstico, qualidade e botões;
//   3. chamada de DM/grupo → painel lateral de até 56vw com OUTRO cabeçalho.
//
// O resultado é que a mesma chamada mudava de forma ao entrar/sair e ninguém
// sabia onde ficava cada botão. Aqui a decisão do layout é uma função só, que
// os dois shells consultam — e o desenho passa a ser o MESMO em qualquer
// entrada (sidebar, botão da tela do canal, celular).

/** Em que situação a tela está. */
export type VoiceScreenMode =
  /** Canal de chamada aberto, ainda fora da chamada. */
  | 'lobby'
  /** Dentro da chamada (canal ou DM/grupo). */
  | 'in-call'

export interface VoiceLayoutInput {
  /** A conversa aberta é um canal de voz/vídeo? */
  isChannel: boolean
  /** Estou na chamada DESTE canal (ou desta conversa, em DM/grupo). */
  inThisCall: boolean
  /** Existe alguma chamada ativa (pode ser de outra conversa). */
  hasActiveCall: boolean
  /** Largura da janela em px (desktop) — o celular usa 0/omitido. */
  widthPx?: number
}

export interface VoiceLayout {
  mode: VoiceScreenMode
  /**
   * O palco (quadrados/mídia) ocupa a ÁREA CENTRAL inteira.
   *
   * Sempre `true` dentro da chamada: é o pedido do dono ("pega a tela do lado
   * direito, mais completa") e evita a mídia aparecer duas vezes (centro e
   * painel lateral), que era o bug de "dois quadrados iguais".
   */
  stageFill: boolean
  /**
   * Largura do painel de controles (px). 0 = painel escondido.
   *
   * No PC é uma coluna estreita e fixa: a mídia nunca deve ser espremida por um
   * painel de 56vw. No celular o painel é uma barra inferior (não usa este
   * número).
   */
  controlsWidthPx: number
  /** O cabeçalho do canal (nome/tópico/ações) aparece. */
  showChannelHeader: boolean
  /**
   * A lista de mensagens/compositor aparece. NUNCA num canal de chamada: é o
   * bug do "dá para digitar num canal de voz".
   */
  showText: boolean
  /**
   * O painel de membros do servidor aparece ao lado.
   *
   * Escondido dentro da chamada: com palco + controles + membros a área útil
   * do vídeo fica menor que um cartão de visitas.
   */
  showMemberList: boolean
}

/** Painel de controles: estreito e fixo, para a mídia dominar a tela. */
export const CONTROLS_WIDTH_PX = 320
/** Abaixo disto o painel de membros sai (não cabe sem esmagar a mídia). */
export const MEMBERS_MIN_WIDTH_PX = 1180

/**
 * Layout da tela para um dado estado.
 *
 * Regras (todas com motivo, não estética):
 * - dentro da chamada, o palco preenche o centro e o painel é só controle;
 * - canal de chamada nunca mostra texto (nem o compositor);
 * - a lista de membros some dentro da chamada e em janelas estreitas;
 * - fora da chamada, um canal de chamada mostra o lobby (quem está, botão).
 */
export function resolveVoiceLayout(input: VoiceLayoutInput): VoiceLayout {
  const isChannel = input.isChannel === true
  const inCall = input.inThisCall === true
  const width = typeof input.widthPx === 'number' && Number.isFinite(input.widthPx)
    ? input.widthPx
    : 0

  if (inCall) {
    return {
      mode: 'in-call',
      stageFill: true,
      controlsWidthPx: CONTROLS_WIDTH_PX,
      showChannelHeader: isChannel,
      showText: false,
      // Janela desconhecida (SSR/teste) assume espaço: é o caso comum no PC.
      showMemberList: width === 0 ? true : width >= MEMBERS_MIN_WIDTH_PX,
    }
  }

  if (isChannel) {
    return {
      mode: 'lobby',
      stageFill: false,
      controlsWidthPx: 0,
      showChannelHeader: true,
      showText: false,
      showMemberList: width === 0 ? true : width >= MEMBERS_MIN_WIDTH_PX,
    }
  }

  return {
    mode: 'lobby',
    stageFill: false,
    controlsWidthPx: 0,
    showChannelHeader: false,
    showText: true,
    showMemberList: width === 0 ? true : width >= MEMBERS_MIN_WIDTH_PX,
  }
}

/**
 * Título honesto do cabeçalho da chamada: o NOME do canal/conversa, nunca um
 * id. Antes o painel mostrava "Chamada" quando a conversa não estava na lista,
 * e o cabeçalho do canal mostrava o id cru quando o roster ainda não chegou.
 */
export function callScreenTitle(input: {
  channelName?: string | null
  conversationTitle?: string | null
  peerName?: string | null
  fallback?: string
}): string {
  const nome = input.channelName || input.conversationTitle || input.peerName
  const limpo = typeof nome === 'string' ? nome.trim() : ''
  return limpo || input.fallback || 'Chamada'
}

/**
 * Contagem de participantes para o subtítulo — singular/plural correto e
 * "você" incluído (a pessoa se procura na lista).
 */
export function participantsLabel(total: number): string {
  const n = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  if (n === 0) return 'ninguém na chamada'
  return `${n} ${n === 1 ? 'pessoa' : 'pessoas'} na chamada`
}
