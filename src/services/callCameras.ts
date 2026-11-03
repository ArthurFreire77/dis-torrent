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
