import React, { useEffect, useRef, useState } from 'react'
import { Ic } from '../../shared/icons'
import { callManager } from '../../services/callManager'
import {
  SOUND_MAX_BYTES, SOUND_MAX_SECONDS, SOUND_SUGGESTIONS,
  isDownloadableSoundUrl, type SoundMeta, soundMime, soundNameSlug,
} from '../../services/soundboardRules'
import {
  soundDelete, soundDownload, soundList, soundSave, soundboard,
} from '../../services/soundboard'
import { base64ToBytes } from '../../shared/base64'

// Painel dos efeitos: com mic mudo o som toca só local, e a UI avisa isso.
export function SoundboardPanel({ open, onClose, palette }: {
  open: boolean
  onClose: () => void
  palette: { input: string; border: string; text: string; muted: string; accent: string; panel: string }
}) {
  const [sons, setSons] = useState<SoundMeta[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [tocando, setTocando] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const recarregar = () => { void soundList().then(setSons).catch(() => setSons([])) }

  useEffect(() => { if (open) recarregar() }, [open])
  useEffect(() => {
    if (!aviso) return
    const t = setTimeout(() => setAviso(null), 3200)
    return () => clearTimeout(t)
  }, [aviso])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  async function tocar(meta: SoundMeta) {
    setErro(null)
    setTocando(meta.id)
    try {
      const ok = await callManager.playSound(meta, true)
      if (!ok) setErro('não foi possível decodificar este som')
      else if (!callManager.soundboardLive()) {
        setAviso('microfone fechado — o som tocou só para você')
      }
    } catch (e: any) { setErro(String(e?.message ?? e)) }
    setTimeout(() => setTocando(t => (t === meta.id ? null : t)), 400)
  }

  async function subir(file: File) {
    setErro(null)
    setBusy('upload')
    try {
      const prep = await soundboard.prepare(file)
      const saved = await soundSave(prep.meta, prep.bytes)
      recarregar()
      setAviso(`"${saved.name}" salvo (${saved.seconds ? `${saved.seconds.toFixed(1)}s` : soundMime(saved.ext)})`)
    } catch (e: any) { setErro(String(e?.message ?? e)) } finally { setBusy(null) }
  }

  async function baixar() {
    const alvo = url.trim()
    if (!isDownloadableSoundUrl(alvo)) {
      setErro('cole um link https:// direto do áudio (MP3, OGG, WAV…)')
      return
    }
    setErro(null)
    setBusy('download')
    try {
      const got = await soundDownload(alvo)
      if (got.bytes > SOUND_MAX_BYTES) throw new Error('arquivo acima do limite de 2 MB')
      const bytes = base64ToBytes(got.bytes_b64)
      const seconds = await soundboard
        .prepare(new File([bytes as unknown as BlobPart], `${got.name}.${got.ext}`))
        .then(p => p.meta.seconds)
        .catch(() => 0)
      if (seconds > SOUND_MAX_SECONDS + 0.25) throw new Error(`o áudio tem ${seconds.toFixed(1)}s — máximo ${SOUND_MAX_SECONDS}s`)
      const saved = await soundSave(
        { name: soundNameSlug(got.name), ext: got.ext, bytes: bytes.length, seconds, source: alvo },
        bytes,
      )
      setUrl('')
      recarregar()
      setAviso(`"${saved.name}" baixado e salvo`)
    } catch (e: any) { setErro(String(e?.message ?? e)) } finally { setBusy(null) }
  }

  async function apagar(meta: SoundMeta) {
    setErro(null)
    try {
      await soundDelete(meta.id)
      soundboard.clearCache()
      recarregar()
    } catch (e: any) { setErro(String(e?.message ?? e)) }
  }

  const head: React.CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: 1, color: palette.muted, marginBottom: 6 }

  return (
    <>
      {/* Backdrop clicável: o painel é fixed e sem isto ficaria impossível fechar fora do X. */}
      <div onClick={onClose} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 199 }} />
      <div
        role="dialog"
        aria-label="Efeitos sonoros da chamada"
        style={{
          position: 'fixed', bottom: 96, right: 24, zIndex: 200,
          width: 330, maxWidth: '92vw', maxHeight: '60vh', overflowY: 'auto',
          background: palette.panel, border: `1px solid ${palette.border}`, borderRadius: 10,
          padding: 12, boxShadow: '0 12px 36px rgba(0,0,0,.55)',
        }}
      >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ ...head, margin: 0 }}>EFEITOS DA CHAMADA</span>
        <button onClick={onClose} aria-label="Fechar efeitos" style={{ background: 'transparent', border: 'none', color: palette.muted, cursor: 'pointer', display: 'flex' }}><Ic name="x" size={14} /></button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          style={{ flex: 1, background: palette.accent, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 10px', fontWeight: 800, fontSize: 12, cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.6 : 1 }}
        >{busy === 'upload' ? 'Enviando…' : 'Enviar som'}</button>
        <input
          ref={fileRef} type="file" accept="audio/wav,audio/ogg,audio/flac,audio/mp4,audio/mpeg,.wav,.ogg,.flac,.m4a,.mp3" hidden
          aria-label="Escolher arquivo de som"
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void subir(f) }}
        />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void baixar() }}
          placeholder="https://… link direto do áudio"
          aria-label="Link do som para baixar"
          style={{ flex: 1, minWidth: 0, background: palette.input, border: `1px solid ${palette.border}`, borderRadius: 6, padding: '7px 9px', color: palette.text, fontSize: 12, outline: 'none' }}
        />
        <button
          onClick={() => void baixar()}
          disabled={busy !== null || !url.trim()}
          style={{ background: palette.input, border: `1px solid ${palette.border}`, color: palette.text, borderRadius: 6, padding: '7px 10px', fontSize: 12, fontWeight: 700, cursor: busy ? 'progress' : 'pointer', opacity: busy || !url.trim() ? 0.55 : 1 }}
        >{busy === 'download' ? '…' : 'Baixar'}</button>
      </div>

      <div style={{ fontSize: 10.5, color: palette.muted, lineHeight: 1.45, marginBottom: 10 }}>
        Até {SOUND_MAX_SECONDS}s e {SOUND_MAX_BYTES / 1024 / 1024} MB. Arquivos do PC ou link https direto de um áudio.
        {SOUND_SUGGESTIONS.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
            {SOUND_SUGGESTIONS.map(s => (
              <button
                key={s.label}
                type="button"
                title={`${s.detail} — pesquise "${s.query}"`}
                onClick={() => { setUrl(''); setAviso(`Procure "${s.query}" e cole aqui o link https do áudio`) }}
                style={{ background: palette.input, border: `1px solid ${palette.border}`, color: palette.muted, borderRadius: 99, padding: '2px 8px', fontSize: 10.5, cursor: 'pointer' }}
              >{s.label}</button>
            ))}
          </div>
        )}
      </div>

      {erro && <div style={{ color: '#ff9c9c', fontSize: 11.5, marginBottom: 8 }}>{erro}</div>}
      {aviso && <div style={{ color: '#9be7b0', fontSize: 11.5, marginBottom: 8 }}>{aviso}</div>}

      <div style={head}>SEUS SONS · {sons.length}</div>
      {sons.length === 0 ? (
        <div style={{ fontSize: 11.5, color: palette.muted, padding: '6px 0' }}>Nada ainda. Envie um arquivo curto ou baixe de um link.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {sons.map(s => (
            <div key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, background: palette.input, border: `1px solid ${palette.border}`, borderRadius: 8, padding: 6 }}>
              <button
                onClick={() => void tocar(s)}
                title={`${s.name} · ${s.seconds ? `${s.seconds.toFixed(1)}s` : s.ext}`}
                style={{ background: tocando === s.id ? palette.accent : 'transparent', border: 'none', color: tocando === s.id ? '#fff' : palette.text, borderRadius: 6, padding: '6px 4px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >▶ {s.name}</button>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 9.5, color: palette.muted }}>
                <span>{s.seconds ? `${s.seconds.toFixed(1)}s` : s.ext}</span>
                <button onClick={() => void apagar(s)} aria-label={`Apagar ${s.name}`} title="Apagar" style={{ background: 'transparent', border: 'none', color: palette.muted, cursor: 'pointer', fontSize: 12, padding: 0 }}>×</button>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>
    </>
  )
}
