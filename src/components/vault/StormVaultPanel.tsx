import { useCallback, useEffect, useRef, useState } from 'react'
import { services } from '../../services'
import type { VaultBackupInfo, VaultImportReport } from '../../services/models'
import { DownloadTargetBox } from './DownloadTargetBox'
import {
  SPEED_PRESETS,
  getDownloadSpeedLimit,
  labelForLimit,
  setDownloadSpeedLimit,
} from '../../services/downloadSpeed'

const t = {
  input: '#1e1f22', border: '#26272b', text: '#dbdee1',
  muted: '#949ba4', accent: '#5865f2', green: '#23a559', red: '#f23f43',
}
const label: React.CSSProperties = { display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted, marginBottom: 6 }
const input: React.CSSProperties = { width: '100%', background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '10px 12px', color: t.text, fontSize: 13, boxSizing: 'border-box' }
const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({ background: bg, color: fg, border: 'none', padding: '10px 14px', borderRadius: 8, fontWeight: 800, cursor: 'pointer', fontSize: 12 })

export function StormVaultPanel() {
  const [expPass, setExpPass] = useState('')
  const [impPass, setImpPass] = useState('')
  const [includeSecret, setIncludeSecret] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgErr, setMsgErr] = useState<string | null>(null)
  const [backups, setBackups] = useState<VaultBackupInfo[]>([])
  const [retention, setRetention] = useState(7)
  const [wipeText, setWipeText] = useState('')
  const [pickedFile, setPickedFile] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const impFile = useRef<{ name: string; b64: string } | null>(null)

  const refreshBackups = useCallback(async () => {
    if (services.kind !== 'native') return
    try {
      const [list, days] = await Promise.all([services.stormvaultBackupsList(), services.stormvaultBackupGetRetention()])
      setBackups(list)
      setRetention(days)
    } catch {  }
  }, [])

  useEffect(() => {
    void refreshBackups()
  }, [refreshBackups])

  const doExport = async () => {
    setBusy('export')
    setMsg(null)
    setMsgErr(null)
    try {
      const r = await services.stormvaultExport(expPass, { includeSecret })
      const fp = r.header.fp
      setMsg(`✅ Cofre exportado: ${r.path} (${(r.bytes / 1024).toFixed(0)} KB) — ${r.header.msg_count} mensagens de ${r.header.nickname}. Fingerprint ${fp} — confira que é o SEU nas configurações. Arquivo + senha = a conta; guarde os dois longe deste PC.`)
      setExpPass('')
    } catch (e) {
      setMsgErr(`não consegui exportar: ${String((e as Error)?.message ?? e).replace(/"/g, '')}`)
    } finally {
      setBusy(null)
    }
  }

  const doImport = async () => {
    if (!impFile.current) {
      setMsgErr('escolha o arquivo .stormvault primeiro')
      return
    }
    setBusy('import')
    setMsg(null)
    setMsgErr(null)
    try {
      const r: VaultImportReport = await services.stormvaultImportFile(impFile.current.b64, impPass)
      setMsg(importSummary(r))
      setImpPass('')
      setPickedFile(null)
      impFile.current = null
      if (fileRef.current) fileRef.current.value = ''
      if (r.identity_installed) {
        setMsg(`${importSummary(r)} Recarregando para entrar…`)
        window.setTimeout(() => window.location.reload(), 1500)
      }
    } catch (e) {
      setMsgErr(String((e as Error)?.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const doBackupNow = async () => {
    setBusy('backup')
    try {
      const b = await services.stormvaultBackupNow()
      setMsg(`Snapshot criado: ${b.file}`)
      void refreshBackups()
    } catch (e) {
      setMsgErr(String((e as Error)?.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const doRestore = async (file: string) => {
    if (!window.confirm(`Restaurar o backup ${file}? Os dados atuais são mesclados (nada é perdido).`)) return
    setBusy('restore')
    try {
      const r = await services.stormvaultBackupRestore(file)
      setMsg(importSummary(r))
    } catch (e) {
      setMsgErr(String((e as Error)?.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const doWipe = async () => {
    setBusy('wipe')
    try {
      const r = await services.vaultWipe(wipeText)
      setWipeText('')
      try {
        for (const storage of [localStorage, sessionStorage]) {
          const doomed: string[] = []
          for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i)
            if (k && k.startsWith('distorrent:')) doomed.push(k)
          }
          doomed.forEach((k) => storage.removeItem(k))
        }
      } catch {  }
      const extra = r.leftovers.length > 0
        ? ` Apague também manualmente: ${r.leftovers.join(', ')}`
        : ''
      setMsg(`Dados locais apagados. Reinicie o app.${extra}`)
    } catch (e) {
      setMsgErr(String((e as Error)?.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const dangerZone = (
    <div>
      <div style={{ ...label, marginTop: 14, color: t.red }}>ZONA DE PERIGO — MODO PÂNICO</div>
      <div style={{ fontSize: 11, color: t.muted, marginBottom: 6, lineHeight: 1.5 }}>
        Apaga IMEDIATAMENTE identidade, mensagens, contatos e backups DESTE dispositivo. Sem desfazer.
        {services.kind === 'native'
          ? ' A senha do cofre continua válida para reimportar um .stormvault guardado fora daqui.'
          : ' Neste modo navegador, apaga os dados locais do site.'}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={wipeText} onChange={(e) => setWipeText(e.target.value)} placeholder="digite APAGAR para confirmar" style={{ ...input, flex: 1, color: t.text }} />
        <button onClick={() => void doWipe()} disabled={busy !== null || wipeText !== 'APAGAR'} style={btn('#f23f43')}>Apagar tudo</button>
      </div>
    </div>
  )

  if (services.kind !== 'native') {
    return (
      <div>
        <div style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 10, padding: '12px 14px', fontSize: 12, color: t.muted, lineHeight: 1.5 }}>
          Cofre portátil (.stormvault) funciona apenas no <b style={{ color: t.text }}>app nativo</b> —
          instale o DisTorrent no desktop/Android para exportar e importar sua conta entre dispositivos.
        </div>
        {dangerZone}
        {msg && <div style={{ marginTop: 10, fontSize: 12, color: '#8cf5b8', background: '#1a3329', border: '1px solid #23a55955', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }}>{msg}</div>}
        {msgErr && <div style={{ marginTop: 10, fontSize: 12, color: '#ff9c9c', background: '#2a1518', border: '1px solid #f23f4355', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }}>{msgErr}</div>}
      </div>
    )
  }

  return (
    <div>
      {
}
      {msg && <div role="status" style={{ background: '#1a3329', border: '1px solid #23a55955', borderRadius: 8, padding: '8px 10px', marginBottom: 10, fontSize: 12, color: '#8cf5b8', lineHeight: 1.5 }}>{msg}</div>}
      {msgErr && <div role="alert" style={{ background: '#2a1518', border: '1px solid #f23f4355', borderRadius: 8, padding: '8px 10px', marginBottom: 10, fontSize: 12, color: '#ff9c9c', lineHeight: 1.5 }}>{msgErr}</div>}

      {}
      <div style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12, fontSize: 11.5, color: t.muted, lineHeight: 1.6 }}>
        <b style={{ color: t.text }}>Seu cofre é um arquivo só, sempre criptografado.</b> Ele leva sua
        identidade (chave privada), perfil (avatar, banner e status), amigos, conversas, mensagens,
        reações, fixados, marcadores, comunidades e preferências. Serve para trocar de celular/computador
        ou fazer backup. Quem tiver o arquivo <b>e</b> a senha tem a sua conta — guarde os dois longe
        deste aparelho.
        <div style={{ marginTop: 8 }}>
          <b style={{ color: t.text }}>Sua identidade verificável é o fingerprint</b> (12 caracteres
          hex): ele é derivado da sua chave pública e aparece no header do arquivo. Não existe nome,
          e-mail nem servidor que prove quem é quem — só a chave assinando.
        </div>
      </div>

      <div style={label}>1. EXPORTAR COFRE</div>
      <div style={{ fontSize: 11, color: t.muted, marginBottom: 8, lineHeight: 1.5 }}>
        Cria o arquivo <b style={{ color: t.text }}>.stormvault</b> protegido por uma senha sua.
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <input
          type="password"
          value={expPass}
          onChange={(e) => setExpPass(e.target.value)}
          placeholder="crie uma senha (mín. 8 caracteres)"
          aria-label="Senha do cofre a exportar"
          style={{ ...input, flex: 1 }}
        />
        <button onClick={() => void doExport()} disabled={busy !== null || [...expPass].length < 8} style={btn(t.accent)}>Exportar</button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: t.muted, marginBottom: 6 }}>
        <input type="checkbox" checked={includeSecret} onChange={(e) => setIncludeSecret(e.target.checked)} style={{ accentColor: t.accent }} />
        levar minha chave privada (obrigatório para usar em outro dispositivo)
      </label>
      {includeSecret && (
        <div style={{ fontSize: 11, color: '#faa61a', marginBottom: 6, lineHeight: 1.5 }}>
          este arquivo + a senha = sua conta inteira. Não mande para ninguém.
        </div>
      )}

      <div style={{ ...label, marginTop: 18 }}>2. IMPORTAR COFRE</div>
      <div style={{ fontSize: 11, color: t.muted, marginBottom: 8, lineHeight: 1.5 }}>
        Traz a conta de volta para este aparelho. Precisa do arquivo e da senha que você criou.
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".stormvault"
        aria-label="Arquivo .stormvault para importar"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (!f) return
          setMsgErr(null)
          const reader = new FileReader()
          reader.onerror = () => {
            setMsgErr('falha ao ler o arquivo — tente de novo')
          }
          reader.onload = () => {
            try {
              const res = String(reader.result ?? '')
              const b64 = res.indexOf(',') >= 0 ? res.split(',')[1] ?? '' : res
              if (!b64) {
                setMsgErr('arquivo vazio ou ilegível')
                return
              }
              impFile.current = { name: f.name, b64 }
              setPickedFile(f.name)
              setMsg(`arquivo pronto: ${f.name}`)
            } catch {
              setMsgErr('falha ao ler o arquivo — tente de novo')
            }
          }
          reader.readAsDataURL(f)
        }}
      />
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <button onClick={() => fileRef.current?.click()} style={{ ...btn(t.input, t.text), border: `1px solid ${t.border}`, flex: 1, minWidth: 160 }}>
          {pickedFile ? pickedFile : 'Escolher arquivo…'}
        </button>
        <input
          type="password"
          value={impPass}
          onChange={(e) => setImpPass(e.target.value)}
          placeholder="senha do cofre"
          aria-label="Senha do cofre a importar"
          style={{ ...input, flex: 1, minWidth: 160 }}
        />
        <button onClick={() => void doImport()} disabled={busy !== null || [...impPass].length < 8 || !pickedFile} style={btn(t.accent)}>Importar</button>
      </div>

      <div style={{ ...label, marginTop: 18, paddingTop: 12, borderTop: `1px solid ${t.border}` }}>ARQUIVOS E MÍDIA</div>
      <DownloadTargetBox />
      <CacheBox />
      <div style={{ ...label, marginTop: 18, paddingTop: 12, borderTop: `1px solid ${t.border}` }}>BACKUPS AUTOMÁTICOS</div>
      <div style={{ fontSize: 11, color: t.muted, marginBottom: 8, lineHeight: 1.5 }}>
        O app cria cópias do cofre sozinho enquanto ele está desbloqueado. É a rede de segurança —
        para levar a conta para outro aparelho use o <b style={{ color: t.text }}>Exportar</b> acima.
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <select
          value={retention}
          aria-label="Retenção de backups"
          onChange={(e) => {
            const d = Number(e.target.value)
            const prev = retention
            setRetention(d)
            setMsg(null)
            setMsgErr(null)
            services.stormvaultBackupSetRetention(d).catch((err) => {
              setRetention(prev)
              setMsgErr(String((err as Error)?.message ?? err))
            })
          }}
          style={{ ...input, flex: 1 }}
        >
          <option value={7}>manter 7 dias</option>
          <option value={30}>manter 30 dias</option>
          <option value={90}>manter 90 dias</option>
        </select>
        <button onClick={() => void doBackupNow()} disabled={busy !== null} style={btn(t.green)}>Criar agora</button>
      </div>
      <MediaSafetyBox />
      {backups.length === 0
        ? <div style={{ fontSize: 11, color: t.muted }}>nenhum snapshot ainda — o app cria backups enquanto está desbloqueado</div>
        : backups.map((b) => (
          <div key={b.file} style={{ display: 'flex', alignItems: 'center', gap: 8, background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
            <div style={{ flex: 1, fontSize: 11, color: t.text, fontFamily: 'JetBrains Mono' }}>{b.file}</div>
            <div style={{ fontSize: 11, color: t.muted }}>{(b.bytes / 1024).toFixed(0)} KB</div>
            <button onClick={() => void doRestore(b.file)} disabled={busy !== null} style={{ ...btn(t.input, t.text), border: `1px solid ${t.border}`, padding: '4px 10px', fontSize: 11 }}>Restaurar</button>
          </div>
        ))}

      {dangerZone}
    </div>
  )
}

function CacheBox() {
  const [ttl, setTtl] = useState(7)
  const [stats, setStats] = useState<{ total_bytes: number; entries: number; cap_mb: number } | null>(null)
  const [spool, setSpool] = useState<{ bytes: number; entries: number } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [vel, setVel] = useState(() => getDownloadSpeedLimit())
  useEffect(() => {
    if (services.kind !== 'native') return
    void services.cacheGetTtl().then(setTtl).catch(() => {})
    void services.cacheStats().then(setStats).catch(() => {})
    void services.spoolStats().then(setSpool).catch(() => {})
  }, [])
  if (services.kind !== 'native') return null
  return (
    <div style={{ marginTop: 14 }}>
      <div style={label}>VELOCIDADE DO DOWNLOAD</div>
      <div style={{ fontSize: 11, color: t.muted, lineHeight: 1.5, marginBottom: 8 }}>
        Sem teto o app usa a rede inteira (e os limites de segurança do motor continuam ativos:
        um peer não consegue saturar a sua máquina). Com teto, a janela de blocos diminui de verdade.
      </div>
      <select
        value={vel}
        aria-label="Teto de velocidade do download"
        onChange={(e) => {
          const n = Number(e.target.value)
          const v = setDownloadSpeedLimit(n)
          setVel(v)
          setMsg(v > 0 ? `download limitado a ${v} MB/s` : 'download sem teto (rede inteira)')
        }}
        style={{ ...input, width: '100%' }}
      >
        {SPEED_PRESETS.map((p) => (
          <option key={p} value={p}>{labelForLimit(p)}</option>
        ))}
      </select>

      <div style={{ ...label, marginTop: 14 }}>CACHE DE PRÉVIAS</div>
      <div style={{ fontSize: 11, color: t.muted, lineHeight: 1.5, marginBottom: 8 }}>
        Só prévia de mídia fica guardada: imagem até <b style={{ color: t.text }}>7 MB</b> e vídeo até{' '}
        <b style={{ color: t.text }}>250 MB</b>, por {ttl} dias. Acima disso nada é guardado sem você mandar baixar —
        um vídeo de 2 GB não enche o disco sozinho.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={ttl}
          aria-label="Tempo do cache de prévias"
          onChange={(e) => {
            const d = Number(e.target.value)
            const prev = ttl
            setTtl(d)
            services.cacheSetTtl(d).then(() => setMsg(`cache limpo em ${d} dia(s)`)).catch(() => setTtl(prev))
          }}
          style={{ ...input, flex: 1, minWidth: 160 }}
        >
          <option value={1}>guardar 1 dia</option>
          <option value={7}>guardar 7 dias</option>
          <option value={15}>guardar 15 dias</option>
          <option value={30}>guardar 30 dias</option>
        </select>
        <button
          type="button"
          onClick={() => {
            services.spoolGc().then((n) => {
              setMsg(n > 0 ? `${(n / (1024 * 1024)).toFixed(0)} MB de downloads parados apagados` : 'nada antigo para apagar')
              void services.spoolStats().then(setSpool).catch(() => {})
            }).catch((e) => setMsg(String((e as Error)?.message ?? e)))
          }}
          style={{ ...btn(t.input, t.text), border: `1px solid ${t.border}` }}
        >
          Limpar downloads parados
        </button>
      </div>
      <div style={{ fontSize: 10.5, color: t.muted, marginTop: 6 }}>
        {stats ? `${(stats.total_bytes / (1024 * 1024)).toFixed(1)} MB em ${stats.entries} bloco(s) de prévia` : ''}
        {spool && spool.entries > 0 ? ` • ${(spool.bytes / (1024 * 1024)).toFixed(0)} MB em ${spool.entries} download(s) em andamento` : ''}
      </div>
      {msg && <div style={{ fontSize: 11, color: '#8cf5b8', marginTop: 6 }}>{msg}</div>}
    </div>
  )
}

function MediaSafetyBox() {
  const [safety, setSafety] = useState<{ strip_exif: boolean; block_executables: boolean } | null>(null)
  useEffect(() => {
    services.mediaSafetyGet().then(setSafety).catch(() => {})
  }, [])
  if (!safety) return null
  const flip = (key: 'strip_exif' | 'block_executables', v: boolean) => {
    const next = { ...safety, [key]: v }
    setSafety(next)
    services.mediaSafetySet(next.strip_exif, next.block_executables).catch(() => {
      services.mediaSafetyGet().then(setSafety).catch(() => {})
    })
  }
  return (
    <div style={{ marginTop: 14, marginBottom: 4 }}>
      <div style={label}>SEGURANÇA DE MÍDIA</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: t.muted, marginBottom: 6 }}>
        <input type="checkbox" checked={safety.strip_exif} onChange={(e) => flip('strip_exif', e.target.checked)} style={{ accentColor: t.accent }} />
        remover metadados (EXIF/GPS) de JPEG/PNG recebidos
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: t.muted, marginBottom: 6 }}>
        <input type="checkbox" checked={safety.block_executables} onChange={(e) => flip('block_executables', e.target.checked)} style={{ accentColor: t.accent }} />
        bloquear executáveis e scripts recebidos por P2P
      </label>
      <div style={{ fontSize: 11, color: t.muted, lineHeight: 1.5 }}>
        vídeos e PDFs não têm metadados removidos — confira antes de repassar
      </div>
    </div>
  )
}

function importSummary(r: VaultImportReport): string {
  const what = r.identity_installed ? 'conta instalada neste dispositivo' : 'dados mesclados na conta existente'
  const parts = [
    `${r.messages_merged} mensagens`, `${r.friends_merged} amigos`,
    `${r.communities_merged} comunidades`, `${r.conversations_added} conversas`,
  ]
  if (r.profiles_merged > 0) parts.push(`${r.profiles_merged} perfis`)
  if (r.social_merged > 0) parts.push(`${r.social_merged} itens sociais`)
  if (r.rules_merged > 0) parts.push(`${r.rules_merged} regras`)
  if (r.reputations_merged > 0) parts.push(`${r.reputations_merged} reputações`)
  if (r.audit_merged > 0) parts.push(`${r.audit_merged} eventos de auditoria`)
  if (r.message_conflicts > 0) parts.push(`${r.message_conflicts} conflitos mantidos locais`)
  const extras: string[] = []
  if (r.messages_truncated) extras.push('Atenção: o cofre tinha mais mensagens que o limite exportado.')
  if (r.data_version < 2) extras.push('Este cofre é antigo (v1): não traz perfil, reações nem preferências — só o histórico.')
  const extra = extras.length > 0 ? `\n${extras.join(' ')}` : ''
  return `${what}: ${parts.join(', ')}.${extra} Identidade ${r.fp} — use a senha do cofre para entrar.`
}
