import { useCallback, useEffect, useState } from 'react'
import { services } from '../services'
import type { PrivacyMode } from '../services/models'
import { setCallPrivacyForIce } from '../services/callManager'

/**
 * Estado e ações da tela de privacidade, iguais no desktop e no celular.
 * Ficava escrito duas vezes e as duas cópias já tinham divergido.
 */
export function usePrivacySettings(reportError: (msg: string | null) => void) {
  const [mode, setMode] = useState<PrivacyMode>('encrypted')
  const [proxyEffective, setProxyEffective] = useState(false)
  const [proxyAddr, setProxyAddr] = useState('')
  const [proxyIsDefault, setProxyIsDefault] = useState(true)
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState<number | null>(null)
  const [testErr, setTestErr] = useState<string | null>(null)
  const [pendingMode, setPendingMode] = useState<PrivacyMode | null>(null)

  useEffect(() => {
    setCallPrivacyForIce(mode)
    services.privacyGet().then(s => setProxyEffective(!!s.proxy_effective)).catch(() => {})
  }, [mode])

  const refreshExtras = useCallback(async (next?: PrivacyMode) => {
    try {
      const pc = await services.proxyAddrGet(next)
      setProxyAddr(pc.addr)
      setProxyIsDefault(pc.is_default)
    } catch {
      setProxyAddr(next === 'full' ? '127.0.0.1:9050' : '127.0.0.1:1080')
      setProxyIsDefault(true)
    }
  }, [])

  const resetTransient = useCallback(() => {
    setPendingMode(null)
    setTestOk(null)
    setTestErr(null)
  }, [])

  const runTest = useCallback(async () => {
    setTesting(true)
    setTestOk(null)
    setTestErr(null)
    try {
      setTestOk(await services.proxyTest(proxyAddr.trim()))
    } catch (e) {
      setTestErr(String((e as { message?: string })?.message ?? e))
    } finally {
      setTesting(false)
    }
  }, [proxyAddr])

  const saveAndActivate = useCallback(async (next: PrivacyMode) => {
    try {
      await services.proxyAddrSet(proxyAddr.trim(), next)
      const r = await services.privacySet(next)
      setMode(r.mode)
      setProxyEffective(!!r.proxy_effective)
      resetTransient()
      reportError(null)
    } catch (e) {
      reportError(String((e as { message?: string })?.message ?? e))
    }
  }, [proxyAddr, reportError, resetTransient])

  const pickMode = useCallback((next: PrivacyMode) => {
    if (next === 'proxy' || next === 'full') {
      setPendingMode(next)
      setTestOk(null)
      setTestErr(null)
      void refreshExtras(next)
      return
    }
    setPendingMode(null)
    services.privacySet(next).then(r => {
      setMode(r.mode)
      setProxyEffective(!!r.proxy_effective)
      reportError(null)
    }).catch((e: { message?: string }) => reportError(String(e?.message ?? e)))
  }, [refreshExtras, reportError])

  return {
    mode, proxyEffective, proxyAddr, proxyIsDefault, testing, testOk, testErr, pendingMode,
    setMode, setProxyEffective, setProxyAddr, resetTransient, refreshExtras, runTest, saveAndActivate, pickMode,
  }
}
