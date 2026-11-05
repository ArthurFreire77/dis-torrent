type Unit = 'B' | 'KB' | 'MB'

function split(size: number): { value: number; unit: Unit } {
  if (size < 1024) return { value: size, unit: 'B' }
  if (size < 1024 * 1024) return { value: size / 1024, unit: 'KB' }
  return { value: size / (1024 * 1024), unit: 'MB' }
}

export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '0 B'
  const { value, unit } = split(size)
  if (unit === 'B') return `${Math.round(value)} B`
  return `${value.toFixed(unit === 'KB' ? 1 : 2)} ${unit}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '?'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1).replace('.', ',')} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
