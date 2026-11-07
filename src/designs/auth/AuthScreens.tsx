import { useEffect, useRef, useState } from 'react'
import { services } from '../../services'
import type { Identity } from '../../services/models'
import { Icon, Icons } from '../../shared/icons'
import { Avatar } from '../../shared/avatarView'
import { dark, light } from '../../shared/theme'

export interface AuthPalette {
  main: string
  sidebar: string
  input: string
  border: string
  heading: string
  text: string
  muted: string
  accent: string
  red: string
}

const PERKS = [
  { icon: Icons.lock, title: 'Cifrado fim-a-fim', desc: 'só os aparelhos leem' },
  { icon: Icons.users, title: 'Sem servidor', desc: 'direto entre peers' },
  { icon: Icons.key, title: 'Sua chave', desc: 'sem conta online' },
]

export function AuthCard({ palette, mobile, children }: {
  palette: AuthPalette
  mobile?: boolean
  children: React.ReactNode
}) {
  const p = palette
  return (
    <div style={{
      minHeight: mobile ? '100dvh' : '100vh', background: p.main, display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 20,
      fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    }}>
      <div style={{
        background: p.sidebar, border: `1px solid ${p.border}`, borderRadius: 12,
        padding: mobile ? 22 : 28, width: mobile ? '100%' : 440, maxWidth: 440,
        boxShadow: '0 8px 32px rgba(0,0,0,.45)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: mobile ? 12 : 14 }}>
          <span style={{ fontSize: mobile ? 24 : 26, fontWeight: 900, color: p.heading, letterSpacing: 1 }}>DisTorrent</span>
          <div style={{ fontSize: 12, color: p.muted, marginTop: 4 }}>
            {mobile ? 'chat, voz e arquivos P2P — sem cadastro' : 'chat, voz e arquivos P2P — sem servidor, sem cadastro'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: mobile ? 16 : 18 }}>
          {PERKS.map((perk) => (
            <div key={perk.title} style={{
              flex: 1, background: p.input, border: `1px solid ${p.border}`, borderRadius: 8,
              padding: mobile ? '8px 4px' : '9px 6px', textAlign: 'center',
            }}>
              <span style={{ color: p.accent, display: 'inline-flex' }}><Icon d={perk.icon} size={mobile ? 16 : 17} /></span>
              <div style={{ fontSize: 11, fontWeight: 800, color: p.heading, marginTop: mobile ? 4 : 5 }}>{perk.title}</div>
              <div style={{ fontSize: 10, color: p.muted, marginTop: mobile ? 0 : 2 }}>{perk.desc}</div>
            </div>
          ))}
        </div>
        {children}
      </div>
    </div>
  )
}

export function authInputStyle(p: AuthPalette, mobile?: boolean): React.CSSProperties {
  return {
    width: '100%', background: p.input, border: `1px solid ${p.border}`, borderRadius: 8,
    padding: '11px 12px', color: p.text, fontSize: mobile ? 16 : 14, outline: 'none', boxSizing: 'border-box',
  }
}

export function authButtonStyle(p: AuthPalette, mobile?: boolean): React.CSSProperties {
  return {
    width: '100%', background: p.accent, color: '#fff', border: 'none', padding: 12,
    borderRadius: 8, fontWeight: 800, cursor: 'pointer', fontSize: mobile ? 15 : 14,
  }
}

function errorBox(p: AuthPalette, err: string) {
  return (
    <div style={{ fontSize: 12, color: '#ff9c9c', background: '#2a1518', border: `1px solid ${p.red}55`, borderRadius: 6, padding: '6px 10px', marginTop: 10 }}>
      {err}
    </div>
  )
}

function message(e: unknown): string {
  return String((e as { message?: string })?.message ?? e).replace(/"/g, '')
}

/** Lê o cofre em base64 sem estourar a pilha de `String.fromCharCode`. */
async function fileToB64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer())
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode(...buf.subarray(i, i + CH))
  return btoa(bin)
}

export function CreateAccount({ palette, mobile, onDone }: {
  palette: AuthPalette
  mobile?: boolean
  onDone: (identity: Identity) => void
}) {
  const [nick, setNick] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [vaultName, setVaultName] = useState<string | null>(null)
  const [vaultB64, setVaultB64] = useState('')
  const [vaultPass, setVaultPass] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  const inputStyle = authInputStyle(palette, mobile)
  const btnStyle = authButtonStyle(palette, mobile)

  async function submit() {
    setErr(null)
    if (!nick.trim()) return setErr('escolha seu nome')
    setBusy(true)
    try {
      onDone(await services.identityCreate(nick.trim(), null))
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }

  function pickVault() {
    if (services.kind !== 'native') {
      setErr('importar cofre precisa do app instalado (nativo)')
      return
    }
    if (!fileRef.current) return
    fileRef.current.onchange = () => {
      const f = fileRef.current!.files?.[0]
      if (!f) return
      setVaultName(f.name)
      fileToB64(f).then(setVaultB64).catch(() => setErr('falha ao ler o arquivo — tente de novo'))
    }
    fileRef.current.click()
  }

  async function importVault() {
    if (vaultPass.length < 8) return setErr('a senha do cofre precisa de pelo menos 8 caracteres')
    setBusy(true)
    setErr(null)
    try {
      const r = await services.stormvaultImportFile(vaultB64, vaultPass)
      if (r.identity_installed) {
        window.location.reload()
        return
      }
      setErr('o cofre foi mesclado, mas este aparelho já tem outra conta — abra o cofre em Configurações.')
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard palette={palette} mobile={mobile}>
      <div style={{ fontWeight: 800, color: palette.heading, fontSize: 16, marginBottom: 4 }}>Criar conta</div>
      <div style={{ fontSize: 12, color: palette.muted, marginBottom: 14, lineHeight: 1.5 }}>
        Escolha seu nome. Sua chave é gerada neste {mobile ? 'dispositivo' : 'computador'} — <b>sem senha</b>, login direto pela chave.
      </div>
      <input
        style={inputStyle} placeholder="Seu nome" value={nick} autoCapitalize="none" spellCheck={false}
        onChange={e => setNick(e.target.value)} onKeyDown={e => e.key === 'Enter' && void submit()}
      />
      {err && errorBox(palette, err)}
      <button style={{ ...btnStyle, marginTop: 14 }} disabled={busy || !nick.trim()} onClick={submit}>
        {busy ? 'criando…' : 'Criar conta'}
      </button>
      <input ref={fileRef} type="file" accept=".stormvault" style={{ display: 'none' }} aria-label="Escolher cofre para importar" />
      <button onClick={pickVault} disabled={busy} style={{ width: '100%', background: 'transparent', color: palette.muted, border: 'none', padding: 10, borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12, marginTop: 10 }}>
        {vaultName ? `Cofre: ${vaultName}` : 'Já tenho conta em outro aparelho — importar cofre'}
      </button>
      {vaultB64 && (
        <div style={{ marginTop: 8 }}>
          <input
            style={inputStyle} type="password" placeholder="senha do cofre" aria-label="Senha do cofre"
            value={vaultPass} onChange={e => setVaultPass(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void importVault() }}
          />
          <button onClick={() => void importVault()} disabled={busy || vaultPass.length < 8} style={{ ...btnStyle, marginTop: 10 }}>
            {busy ? 'importando…' : 'Importar e entrar'}
          </button>
        </div>
      )}
      <div style={{ fontSize: 11, color: palette.muted, marginTop: 2, textAlign: 'center', lineHeight: 1.5 }}>
        Sem senha — o app verifica se você tem a chave local.
      </div>
    </AuthCard>
  )
}

export interface SavedAccount { nickname: string; fingerprint: string }

export function LockScreen({ palette, mobile, nickname, onUnlock }: {
  palette: AuthPalette
  mobile?: boolean
  nickname: string
  onUnlock: (identity: Identity) => void
}) {
  const [pass, setPass] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<SavedAccount[]>([])
  const [selectedFp, setSelectedFp] = useState<string | null>(null)

  const inputStyle = authInputStyle(palette, mobile)
  const btnStyle = authButtonStyle(palette, mobile)
  const currentNick = saved.find(a => a.fingerprint === selectedFp)?.nickname ?? nickname

  useEffect(() => {
    if (mobile) return
    services.accountsList().then(setSaved).catch(() => {})
  }, [mobile])

  async function submit() {
    setErr(null)
    setBusy(true)
    try {
      if (selectedFp) await services.accountSwitch(selectedFp)
      onUnlock(await services.vaultUnlock(pass))
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard palette={palette} mobile={mobile}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
        <Avatar name={currentNick} fp={selectedFp ?? '0000'} size={mobile ? 64 : 72} />
      </div>
      <div style={{ textAlign: 'center', fontWeight: 800, color: palette.heading, fontSize: 16 }}>Bem-vindo de volta, {currentNick}</div>
      <div style={{ textAlign: 'center', fontSize: 12, color: palette.muted, marginTop: 4, marginBottom: 14 }}>Digite sua senha para desbloquear</div>
      {saved.length > 1 && (
        <select
          value={selectedFp ?? ''} onChange={e => setSelectedFp(e.target.value || null)}
          style={{ ...inputStyle, marginBottom: 8 }}
        >
          <option value="">{nickname}</option>
          {saved.map(a => (
            <option key={a.fingerprint} value={a.fingerprint}>{a.nickname}</option>
          ))}
        </select>
      )}
      <input
        style={inputStyle} autoFocus type="password" placeholder="Sua senha" value={pass}
        onChange={e => setPass(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && pass && void submit()}
      />
      {err && errorBox(palette, err)}
      <button style={{ ...btnStyle, marginTop: 14 }} disabled={busy || !pass} onClick={submit}>
        {busy ? 'entrando…' : 'Entrar'}
      </button>
    </AuthCard>
  )
}

export function BootScreen() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const tm = setTimeout(() => setSlow(true), 5000)
    return () => clearTimeout(tm)
  }, [])
  return (
    <div className="boot">
      <div className="boot-logo">DisTorrent</div>
      <div className="boot-bar"><i /></div>
      <div className="boot-sub">
        {slow
          ? 'ainda iniciando o nó P2P — se demorar muito, confirme se o app nativo está rodando (não só o navegador).'
          : 'abrindo sua identidade e o nó P2P…'}
      </div>
      {slow && (
        <button
          type="button" onClick={() => window.location.reload()}
          style={{ marginTop: 4, background: 'transparent', color: '#b7c0cd', border: '1px solid #2f3742', borderRadius: 8, padding: '8px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
        >
          Recarregar
        </button>
      )}
    </div>
  )
}

export const authPalettes = { dark, light }
