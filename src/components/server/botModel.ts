// Regras PURAS de nome/config de bot, compartilhadas pelo painel de Bots, pelo
// assistente de criação e pelos testes.
//
// Antes a regra vivia dentro de `BotManager.tsx` (que importa React), então o
// wizard precisava mentir sobre o tipo para reusar. Aqui é só dado + decisão.

export const BOT_NAME_MIN = 2
export const BOT_NAME_MAX = 32
/** Mesmo teto do `bot_update` no Rust (16 KB). */
export const BOT_CONFIG_MAX_KB = 16

/**
 * Nome de bot válido? Duplicata compara sem caixa, como o painel sempre fez.
 * `others` são os nomes JÁ usados (sem o bot em edição).
 */
export function validateBotEntryName(name: string, others: readonly string[]): string | null {
  const n = name.trim()
  if (!n) return 'Dê um nome ao bot.'
  if (n.length < BOT_NAME_MIN) return 'O nome precisa ter pelo menos 2 caracteres.'
  if (n.length > BOT_NAME_MAX) return 'O nome pode ter no máximo 32 caracteres.'
  if (!/^[\wÀ-ÿ .-]+$/.test(n)) {
    return 'Use apenas letras, números, espaço, ponto, hífen ou sublinhado.'
  }
  const alvo = n.toLowerCase()
  if (others.some((o) => o.trim().toLowerCase() === alvo)) return 'Já existe um bot com esse nome.'
  return null
}

/** O config cabe no limite do core? (o JSON em si é validado por `parseBotConfig`) */
export function fitsBotConfig(config: string): boolean {
  return config.length <= BOT_CONFIG_MAX_KB * 1024
}
