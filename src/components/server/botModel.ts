export const BOT_NAME_MIN = 2
export const BOT_NAME_MAX = 32
export const BOT_CONFIG_MAX_KB = 64

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

export function fitsBotConfig(config: string): boolean {
  return config.length <= BOT_CONFIG_MAX_KB * 1024
}
