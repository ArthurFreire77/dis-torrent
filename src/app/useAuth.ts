// Hook compartilhado de autenticação — extrai lógica de identidade do ThemeShell/MobileShell.

import { useState, useEffect } from 'react'
import { services } from '../services'
import type { Identity } from '../services/models'

export function useIdentityBase() {
  const [identity, setIdentity] = useState<Identity | null>(null)
  return { identity, setIdentity }
}

export function useAuth() {
  const [phase, setPhase] = useState<'loading' | 'create' | 'lock' | 'app'>('loading')
  const { identity, setIdentity } = useIdentityBase()

  useEffect(() => {
    let mounted = true

    async function init() {
      try {
        const id = await services.identityGet()
        if (!mounted) return
        if (id) {
          setIdentity(id)
          setPhase('app')
        } else {
          const v = await services.vaultStatus()
          if (!mounted) return
          if (!v.has_identity) setPhase('create')
          else {
            try {
              const unlocked = await services.vaultUnlock('')
              if (!mounted) return
              setIdentity(unlocked)
              setPhase('app')
            } catch {
              if (!mounted) return
              if (v.has_vault) setPhase('lock')
              else setPhase('create')
            }
          }
        }
      } catch {
        if (!mounted) return
        try {
          const v = await services.vaultStatus()
          if (!mounted) return
          if (!v.has_identity) setPhase('create')
          else if (v.has_vault) setPhase('lock')
          else setPhase('app')
        } catch {
          if (mounted) setPhase('create')
        }
      }
    }

    init()
    return () => { mounted = false }
  }, [])

  const handleCreate = (id: Identity) => {
    setIdentity(id)
    setPhase('app')
  }

  const handleUnlock = (id: Identity) => {
    setIdentity(id)
    setPhase('app')
  }

  return { phase, identity, setIdentity, handleCreate, handleUnlock }
}
