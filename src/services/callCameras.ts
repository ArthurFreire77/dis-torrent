export interface CameraDevice {
  deviceId: string
  label: string
}

export function cameraDevices(
  devices: Array<{ kind: string; deviceId: string; label: string }> | null | undefined,
): CameraDevice[] {
  if (!Array.isArray(devices)) return []
  const out: CameraDevice[] = []
  const vistos = new Set<string>()
  for (const d of devices) {
    if (!d || d.kind !== 'videoinput') continue
    const id = typeof d.deviceId === 'string' ? d.deviceId : ''
    if (!id || id === 'default' || vistos.has(id)) continue
    vistos.add(id)
    out.push({ deviceId: id, label: (d.label || '').trim() })
  }
  return out
}

export function nextCameraId(devices: CameraDevice[], atual: string): string | null {
  if (!devices.length) return null
  const ids = devices.map((d) => d.deviceId)
  const idx = atual ? ids.indexOf(atual) : -1
  if (idx >= 0) return ids[(idx + 1) % ids.length] ?? null
  if (!atual) return ids[ids.length > 1 ? 1 : 0] ?? null
  return ids[0] ?? null
}

export function cameraCycleLabel(devices: CameraDevice[], atual: string): string | null {
  if (devices.length < 2) return null
  const ids = devices.map((d) => d.deviceId)
  const idx = atual ? ids.indexOf(atual) : -1
  return `Câmera ${idx >= 0 ? idx + 1 : 1} de ${devices.length}`
}

export function shouldShowCameraSwitch(devices: CameraDevice[]): boolean {
  return devices.length > 1
}

/**
 * Dois tracks são da MESMA câmera? Serve para não mentir no "inverter": se o
 * aparelho devolver o mesmo sensor, o vídeo não teria mudado.
 */
export function sameCamera(
  a: { deviceId?: string; facingMode?: string } | null | undefined,
  b: { deviceId?: string; facingMode?: string } | null | undefined,
): boolean {
  if (!a || !b) return false
  const da = typeof a.deviceId === 'string' ? a.deviceId : ''
  const db = typeof b.deviceId === 'string' ? b.deviceId : ''
  if (da && db) return da === db
  const fa = typeof a.facingMode === 'string' ? a.facingMode : ''
  const fb = typeof b.facingMode === 'string' ? b.facingMode : ''
  if (fa && fb) return fa === fb
  return false
}

export interface CameraSwitchInput {
  /** Câmeras com deviceId distinto (o que o navegador consegue alternar). */
  devices: CameraDevice[]
  /** `videoinput` crus, inclusive os que repetem deviceId antes da permissão. */
  rawCount: number
  /** Celular: tem frontal e traseira por definição do aparelho. */
  mobile: boolean
}

/**
 * Decide se o botão de inverter aparece. No celular ele NÃO pode depender do
 * `enumerateDevices`: antes da permissão o Android devolve um único
 * `videoinput` (ou nenhum) e o botão simplesmente não existia. Lá a troca é
 * feita por `facingMode`, que o aparelho sempre entende.
 */
export function shouldShowCameraFlip(input: CameraSwitchInput): boolean {
  if (input.mobile) return true
  if (input.devices.length > 1) return true
  return input.rawCount > 1
}
