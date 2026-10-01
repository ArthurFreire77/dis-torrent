// Componentes de autenticação — AuthCard, CreateAccount, LockScreen.
// Extraídos do ThemeShell.tsx para reutilização e manutenção.

import { useState } from 'react'
import type { Identity } from '../services/models'
import { themeColors, inputStyle, btnStyle, Avatar } from '../shared/utils'
import { services } from '../services'

// ---------- Card de autenticação ----------
export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      height: '100vh',
      background: themeColors.main,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'Inter',
    }}>
      <div style={{
        background: themeColors.sidebar,
        border: `1px solid ${themeColors.border}`,
        borderRadius: 12,
        padding: 28,
        width: 420,
        boxShadow: '0 8px 32px rgba(0,0,0,.45)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 24, fontWeight: 900, color: themeColors.heading, letterSpacing: 1 }}>
            DisTorrent
          </span>
          <div style={{ fontSize: 11, color: themeColors.muted, marginTop: 4 }}>
            comunicação P2P — sem servidor, sem cadastro online
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

// ---------- Criar conta ----------
export function CreateAccount({ onDone }: { onDone: (identity: Identity) => void }) {
  const [nick, setNick] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setErr(null)
    if (!nick.trim()) return setErr('escolha seu nome')
    setBusy(true)
    try {
      const id = await services.identityCreate(nick.trim(), null)
      onDone(id)
    } catch (e: any) {
      setErr(String(e?.message ?? e).replace(/"/g, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard>
      <div style={{ fontWeight: 800, color: themeColors.heading, fontSize: 16, marginBottom: 4 }}>
        Criar conta
      </div>
      <div style={{ fontSize: 12, color: themeColors.muted, marginBottom: 14 }}>
        Escolha seu nome. Sua chave é gerada neste computador — <b>sem senha</b>, login direto pela chave.
      </div>
      <input
        style={inputStyle}
        placeholder="Seu nome"
        value={nick}
        onChange={e => setNick(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
      />
      {err && (
        <div style={{
          fontSize: 12, color: '#ff9c9c', background: '#2a1518',
          border: `1px solid ${themeColors.red}55`, borderRadius: 6,
          padding: '6px 10px', marginTop: 10,
        }}>
          {err}
        </div>
      )}
      <button
        style={{ ...btnStyle, marginTop: 14 }}
        disabled={busy || !nick.trim()}
        onClick={submit}
      >
        {busy ? 'criando…' : 'Criar conta'}
      </button>
      <div style={{ fontSize: 11, color: themeColors.muted, marginTop: 10, textAlign: 'center' }}>
        Sem senha — o app verifica se você tem a chave local.
      </div>
    </AuthCard>
  )
}

// ---------- Tela de bloqueio ----------
export function LockScreen({
  nickname,
  onUnlock,
}: {
  nickname: string
  onUnlock: (identity: Identity) => void
}) {
  const [pass, setPass] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [savedAccounts, setSavedAccounts] = useState<{ nickname: string; fingerprint: string }[]>([])
  const [selectedFp, setSelectedFp] = useState<string | null>(null)

  const currentNick = savedAccounts.find(a => a.fingerprint === selectedFp)?.nickname ?? nickname

  async function submit() {
    setErr(null)
    setBusy(true)
    try {
      if (selectedFp) {
        await services.accountSwitch(selectedFp)
      }
      const id = await services.vaultUnlock(pass)
      onUnlock(id)
    } catch (e: any) {
      setErr(String(e?.message ?? e).replace(/"/g, ''))
    } finally {
      setBusy(false)
    }
  }

  async function handleImport() {
    const payload = prompt('Cole o código de identidade exportado:')
    if (payload?.trim()) {
      try {
        const data = JSON.parse(payload)
        const id = await services.vaultImport(JSON.stringify(data.identity), data.vault_blob)
        await services.accountsList().then(setSavedAccounts)
        setSelectedFp(id.fingerprint)
        alert('Conta importada! Digite a senha dela para destravar.')
      } catch (e: any) {
        setErr(String(e?.message ?? e))
      }
    }
  }

  return (
    <AuthCard>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
        <Avatar name={currentNick} fp={selectedFp ?? '0000'} size={72} />
      </div>
      <div style={{ textAlign: 'center', fontWeight: 800, color: themeColors.heading, fontSize: 16 }}>
        Bem-vindo de volta, {currentNick}
      </div>
      <div style={{ textAlign: 'center', fontSize: 12, color: themeColors.muted, marginTop: 4, marginBottom: 14 }}>
        Digite sua senha para desbloquear
      </div>

      {savedAccounts.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: themeColors.muted, marginBottom: 6 }}>
            CONTAS SALVAS
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {savedAccounts.map(a => (
              <button
                key={a.fingerprint}
                onClick={() => setSelectedFp(a.fingerprint)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px',
                  borderRadius: 8, background: selectedFp === a.fingerprint ? `${themeColors.accent}22` : 'transparent',
                  border: `1px solid ${selectedFp === a.fingerprint ? themeColors.accent : 'transparent'}`,
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <Avatar name={a.nickname} fp={a.fingerprint} size={24} />
                <span style={{ fontSize: 13, fontWeight: 600, color: themeColors.heading, flex: 1 }}>{a.nickname}</span>
                <span style={{ fontSize: 10, fontFamily: 'JetBrains Mono', color: '#70353b' }}>
                  {a.fingerprint.slice(0, 12)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <input
        style={inputStyle}
        autoFocus
        type="password"
        placeholder="Sua senha"
        value={pass}
        onChange={e => setPass(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && pass && submit()}
      />
      {err && (
        <div style={{
          fontSize: 12, color: '#ff9c9c', background: '#2a1518',
          border: `1px solid ${themeColors.red}55`, borderRadius: 6,
          padding: '6px 10px', marginTop: 10,
        }}>
          {err}
        </div>
      )}
      <button
        style={{ ...btnStyle, marginTop: 14 }}
        disabled={busy || !pass}
        onClick={submit}
      >
        {busy ? 'desbloqueando…' : 'Entrar'}
      </button>
      <button
        onClick={handleImport}
        style={{
          width: '100%', background: 'transparent', color: themeColors.muted,
          border: 'none', padding: 8, borderRadius: 6, fontWeight: 600,
          cursor: 'pointer', fontSize: 12, marginTop: 8,
        }}
      >
        Importar outra conta
      </button>
    </AuthCard>
  )
}
