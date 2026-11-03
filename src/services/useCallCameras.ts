import { useEffect, useState } from 'react'
import { cameraDevices, type CameraDevice } from './callCameras'

export function useCallCameras(ativo: boolean): CameraDevice[] {
  const [devices, setDevices] = useState<CameraDevice[]>([])

  useEffect(() => {
    if (!ativo) return
    let vivo = true
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    const ler = async () => {
      if (!md || typeof md.enumerateDevices !== 'function') return
      try {
        const lista = cameraDevices(await md.enumerateDevices())
        if (!vivo) return
        setDevices((cur) =>
          cur.length === lista.length &&
          cur.every((d, i) => d.deviceId === lista[i]!.deviceId && d.label === lista[i]!.label)
            ? cur
            : lista,
        )
      } catch {
      }
    }
    void ler()
    let limpar: (() => void) | null = null
    try {
      md?.addEventListener?.('devicechange', ler)
      limpar = () => {
        try {
          md?.removeEventListener?.('devicechange', ler)
        } catch {
        }
      }
    } catch {
    }
    return () => {
      vivo = false
      limpar?.()
    }
  }, [ativo])

  return devices
}
