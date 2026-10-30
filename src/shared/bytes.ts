// Formatação de tamanho em bytes — fonte ÚNICA da matemática.
//
// Havia duas funções: `fileRules.formatFileSize` ("5.00 MB", ponto) para anexos
// e `updateRules.formatBytes` ("8,9 MB", vírgula) para o cartão de update. As
// duas continuam existindo porque o texto lido pelo usuário mudou de propósito
// em cada contexto — o que não pode continuar é cada uma refazer a divisão e o
// arredondamento (e divergir no caso de 0 bytes).
//
// Módulo puro: roda no `node --test`.

type Unit = 'B' | 'KB' | 'MB'

/** Decompõe o valor na maior unidade que não zera o número. */
function split(size: number): { value: number; unit: Unit } {
  if (size < 1024) return { value: size, unit: 'B' }
  if (size < 1024 * 1024) return { value: size / 1024, unit: 'KB' }
  return { value: size / (1024 * 1024), unit: 'MB' }
}

/**
 * Texto de anexo: "512 B", "2.0 KB", "5.00 MB".
 * Ponto decimal — é o formato histórico dos cartões de arquivo.
 */
export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '0 B'
  const { value, unit } = split(size)
  if (unit === 'B') return `${Math.round(value)} B`
  return `${value.toFixed(unit === 'KB' ? 1 : 2)} ${unit}`
}

/**
 * Texto do cartão de update: "2 KB", "8,9 MB".
 * Vírgula decimal (pt-BR) e "?" quando o tamanho não é conhecido — o cartão não
 * pode exibir "0 KB" e fazer o usuário achar que o instalador veio vazio.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '?'
  // Abaixo de 1 MB o cartão sempre fala em KB (com piso de 1): um instalador de
  // "300 B" não existe, e "0 KB" faria o usuário achar que veio vazio.
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1).replace('.', ',')} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
