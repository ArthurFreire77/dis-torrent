// Rótulos honestos do status de uma mensagem de saída.
//
// Por que um módulo: a bolinha/relógio aparecia igual no PC e no celular, e a
// dica "aguardando conexão" mentia quando o contato estava ONLINE — o problema
// era outro (o peer não confirmou, ou recusou). Aqui o texto depende do estado
// real do contato, e o mesmo arquivo serve aos dois shells.

/** Glifo do status: relógio → ○ → ✓ → ✓✓ → ✓✓ azul → ✕. */
export function statusGlyph(status: string): string {
  switch (status) {
    case 'read':
    case 'delivered':
      return '✓✓'
    case 'sent':
      return '✓'
    case 'sending':
      return '○'
    case 'pending':
      return '🕓'
    case 'failed':
      return '✕'
    default:
      return ''
  }
}

/**
 * `peerOnline`: true = sessão viva com o contato, false = sem sessão,
 * undefined/omitido = não se sabe (grupo, canal, tela sem lista de peers).
 * Sem esse dado o fallback continua sendo "aguardando conexão" — nunca
 * inventamos que o outro lado recebeu.
 */
export function statusTitle(status: string, peerOnline?: boolean): string {
  switch (status) {
    case 'read':
      return 'lida'
    case 'delivered':
      return 'entregue'
    case 'sent':
      return 'enviada'
    case 'sending':
      return 'enviando…'
    case 'pending':
      return peerOnline
        ? 'na fila: o contato está online mas ainda não confirmou a entrega'
        : 'aguardando conexão'
    case 'failed':
      return 'falhou — clique para reenviar'
    default:
      return ''
  }
}
