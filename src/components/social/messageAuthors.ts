// Regras de exibição das mensagens: quem é o autor e quando repetir o perfil.
//
// POR QUE isto vive fora dos componentes: desktop e celular precisam concordar.
// Antes cada tela tinha sua própria conta, e o bot saía como "eu" porque a
// mensagem dele é gravada com o fingerprint do dono (quem assina é o dono; o
// `bot_id` diz quem falou de verdade).
import type { BotView, StoredMessage } from '../../services/models'

/**
 * Janela de agrupamento: passou disso, o perfil volta a aparecer.
 *
 * 30 s é o que o dono pediu — duas mensagens no mesmo minuto não repetem a
 * foto, mas um minuto depois já é outra "conversa".
 */
export const JANELA_AGRUPAMENTO_MS = 30_000

/** Autor real de uma mensagem, já considerando que o bot fala pelo dono. */
export interface AutorDaMensagem {
  /** Fingerprint usado para perfil, cor e clique no avatar. */
  fp: string
  /** Nome mostrado. Para bot é o nome do bot, não o do dono. */
  nome: string
  /** Avatar emoji do bot (`🎵`), quando houver. */
  emoji?: string
  /** `true` quando quem falou foi o bot. */
  bot: boolean
  /** Id do bot, se houver. */
  botId?: string
}

/**
 * Decide o autor visual.
 *
 * A mensagem do bot chega com `direction: 'out'` e `author_fp` = dono, mas
 * `bot_id` preenchido. Quem falou foi o bot: mostrar a foto do dono ali é
 * mentir sobre a autoria.
 */
export function autorDaMensagem(
  m: Pick<StoredMessage, 'author_fp' | 'direction' | 'bot_id'>,
  opts: {
    myFp: string
    bots: Pick<BotView, 'id' | 'name' | 'avatar'>[]
    nomeDe: (fp: string) => string
  },
): AutorDaMensagem {
  const botId = m.bot_id || ''
  if (botId) {
    const bot = opts.bots.find((b) => b.id === botId)
    return {
      fp: botId,
      nome: bot?.name || 'Bot',
      emoji: bot?.avatar || undefined,
      bot: true,
      botId,
    }
  }
  const fp = m.direction === 'out' ? opts.myFp : m.author_fp
  return { fp, nome: opts.nomeDe(fp), bot: false }
}

/**
 * Duas mensagens seguidas do MESMO autor dentro da janela ficam agrupadas:
 * a segunda não repete avatar, nome, horário nem os recibos.
 *
 * Autor é comparado pelo id do bot quando existe — dois bots diferentes que
 * falam pelo mesmo dono continuam sendo pessoas diferentes.
 */
export function agruparComAnterior(
  atual: Pick<StoredMessage, 'author_fp' | 'direction' | 'bot_id' | 'ts'>,
  anterior: Pick<StoredMessage, 'author_fp' | 'direction' | 'bot_id' | 'ts'> | null | undefined,
  opts?: { anteriorApagada?: boolean; janelaMs?: number },
): boolean {
  if (!anterior) return false
  if (opts?.anteriorApagada) return false
  const janela = opts?.janelaMs ?? JANELA_AGRUPAMENTO_MS
  if (!(atual.ts - anterior.ts < janela)) return false
  if ((atual.bot_id || '') !== (anterior.bot_id || '')) return false
  return atual.direction === anterior.direction && atual.author_fp === anterior.author_fp
}
