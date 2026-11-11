import { useCallback, useEffect, useRef, useState } from 'react'
import { attachStream, detachStream } from '../../shared/mediaAttach'
import { Icon, Icons } from '../../shared/icons'
import { ParticipantAudioControls } from './ParticipantAudioControls'
import { applyParticipantPlayback } from '../../services/callPlayback'
import type { CallTile as CallTileModel } from '../../services/callTiles'

export interface CallTilePalette {
  heading: string
  muted: string
  green: string
  red: string
  accent: string
  border: string
}

export interface CallTileProps {
  tile: CallTileModel
  pinned?: boolean
  expanded?: boolean
  thumbnail?: boolean
  touch?: boolean
  onPin?: (id: string) => void
  onExpand?: (id: string) => void
  showAudioControls?: boolean
  callDeafened?: boolean
  palette: CallTilePalette
  minHeight?: number
  avatarColor: (fp: string) => string
  avatarB64?: Record<string, string | undefined>
  onOpenProfile?: (fp: string) => void
}

function readAspect(el: HTMLVideoElement | null): string | null {
  try {
    if (!el) return null
    const w = el.videoWidth
    const h = el.videoHeight
    if (!w || !h) return null
    return `${w} / ${h}`
  } catch {
    return null
  }
}

const PARTICIPANT_ASPECT = '16 / 9'

/**
 * A trilha pode continuar `live` depois de `replaceTrack(null)` no outro lado —
 * o WebRTC só a marca `muted`. Sem checar isso, o card ficava no último quadro
 * para sempre (o "parou de compartilhar e a imagem congelou na tela").
 * Imagem estática legitimamente "congelada" (janela parada) ainda toca, porque
 * `muted` só liga quando NENHUM RTP chega — não por falta de mudança visual.
 */
function streamIsPlayable(stream: MediaStream | null | undefined): boolean {
  try {
    return !!stream?.getVideoTracks?.().some(
      (t) => t.readyState === 'live' && (t as MediaStreamTrack & { muted?: boolean }).muted !== true,
    )
  } catch {
    return false
  }
}

/** `attachStream` precisa ser re-chamado quando a trilha desmuta. */
function useUnmuteTick(stream: MediaStream | null | undefined): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const tracks = stream?.getVideoTracks?.() ?? []
    if (tracks.length === 0) return
    let vivo = true
    const bump = () => { if (vivo) setTick((n) => n + 1) }
    for (const t of tracks) {
      try {
        t.addEventListener('unmute', bump)
        t.addEventListener('mute', bump)
        t.addEventListener('ended', bump)
      } catch {  }
    }
    return () => {
      vivo = false
      for (const t of tracks) {
        try {
          t.removeEventListener('unmute', bump)
          t.removeEventListener('mute', bump)
          t.removeEventListener('ended', bump)
        } catch {  }
      }
    }
  }, [stream])
  return tick
}

export function CallTile({
  tile,
  pinned = false,
  expanded = false,
  thumbnail = false,
  touch = false,
  onPin,
  onExpand,
  showAudioControls = false,
  callDeafened = false,
  palette: c,
  minHeight = 150,
  avatarColor,
  avatarB64,
  onOpenProfile,
}: CallTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [aspect, setAspect] = useState<string | null>(null)
  const isScreen = tile.kind === 'screen'
  const muteTick = useUnmuteTick(tile.stream)
  void muteTick

  useEffect(() => () => {
    detachStream(videoRef.current)
    detachStream(audioRef.current)
  }, [])

  const audioSrc = (tile.isLocal ? null : (tile.audioStream ?? tile.stream)) ?? null
  const audioKey = tile.audioKey ?? tile.fp
  useEffect(() => {
    if (!audioSrc) return
    const el = audioRef.current
    if (!el) return
    attachStream(el, audioSrc)
    applyParticipantPlayback(el, audioKey, callDeafened)
  }, [tile.isLocal, tile.kind, tile.fp, audioKey, audioSrc, callDeafened])

  const syncAspect = useCallback(() => {
    const next = readAspect(videoRef.current)
    if (next) setAspect((cur) => (cur === next ? cur : next))
  }, [])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    syncAspect()
    let ro: ResizeObserver | null = null
    try {
      ro = new ResizeObserver(syncAspect)
      ro.observe(el)
    } catch {  }
    el.addEventListener('loadedmetadata', syncAspect)
    el.addEventListener('resize', syncAspect)
    return () => {
      try { ro?.disconnect() } catch {  }
      el.removeEventListener('loadedmetadata', syncAspect)
      el.removeEventListener('resize', syncAspect)
    }
  }, [syncAspect, tile.stream])

  const showVideo = !!tile.stream && streamIsPlayable(tile.stream)
  const showImage = !showVideo && !!tile.videoUrl

  return (
    <div
      data-call-tile={tile.id}
      data-call-participant={tile.kind === 'participant' ? tile.fp : undefined}
      data-call-screen-fp={tile.kind === 'screen' ? tile.fp : undefined}
      style={{
        background: isScreen ? '#000' : `radial-gradient(120% 90% at 50% 20%, #31343a 0%, #22242a 70%)`,
        borderRadius: 12,
        overflow: 'hidden',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...(isScreen ? { minHeight: expanded ? 0 : thumbnail ? 72 : minHeight } : { minHeight: 0 }),
        ...(isScreen && aspect
          ? expanded
            ? {
                aspectRatio: aspect,
                width: '100%',
                height: 'auto',
                maxHeight: '100%',
                minHeight: 0,
                alignSelf: 'center',
                justifySelf: 'center',
              }
            : thumbnail
              ? { aspectRatio: PARTICIPANT_ASPECT, width: '100%', height: 'auto', minHeight: 0 }
              : { width: '100%', height: '100%', minHeight: 0, alignSelf: 'stretch', justifySelf: 'stretch' }
          : null),
        ...(isScreen || expanded || thumbnail
          ? null
          : {
              aspectRatio: PARTICIPANT_ASPECT,
              width: '100%',
              height: 'auto',
              minWidth: 0,
              minHeight: 0,
              alignSelf: 'center',
              justifySelf: 'center',
            }),
        border: `2px solid ${
          tile.speaking && !isScreen ? c.green : tile.muted ? `${c.red}55` : isScreen ? `${c.accent}66` : 'transparent'
        }`,
        boxShadow: '0 2px 10px rgba(0,0,0,.35)',
      }}
    >
      {
}
      <div
        style={
          isScreen
            ? { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }
            : { width: '100%', height: '100%' }
        }
      >
        {showVideo ? (
          <video
            autoPlay
            playsInline
            muted
            ref={(el) => {
              videoRef.current = el
              attachStream(el, tile.stream)
            }}
            style={
              isScreen
                ? {
                    maxWidth: '100%',
                    maxHeight: '100%',
                    width: 'auto',
                    height: 'auto',
                    objectFit: 'contain',
                    background: '#000',
                    display: 'block',
                  }
        : {
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            background: '#000',
            display: 'block',
          }
            }
          />
        ) : showImage ? (
          <img
            src={tile.videoUrl}
            alt={tile.label}
            style={
              isScreen
                ? { width: '100%', height: '100%', objectFit: 'contain', background: '#000' }
                : { width: '100%', height: '100%', objectFit: 'cover', background: '#000' }
            }
          />
        ) : (
          <div style={{ textAlign: 'center', padding: 8 }}>
            {}
            <button
              type="button"
              onClick={isScreen || !onOpenProfile ? undefined : () => onOpenProfile(tile.fp)}
              disabled={isScreen || !onOpenProfile}
              title={isScreen ? undefined : `Ver perfil de ${tile.nickname}`}
              aria-label={isScreen ? undefined : `Ver perfil de ${tile.nickname}`}
              style={{
                width: isScreen ? 64 : 104,
                height: isScreen ? 64 : 104,
                borderRadius: isScreen ? 16 : '50%',
                background: isScreen ? `${c.accent}33` : avatarColor(tile.fp),
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 800,
                fontSize: isScreen ? 26 : 40,
                boxShadow: '0 6px 24px rgba(0,0,0,.4)',
                padding: 0,
                border: isScreen ? 'none' : `2px solid ${c.border}`,
                overflow: 'hidden',
                cursor: isScreen || !onOpenProfile ? 'default' : 'pointer',
              }}
            >
              {isScreen
                ? <Icon d={Icons.screen} size={28} />
                : avatarB64?.[tile.fp]
                  ? <img src={`data:image/jpeg;base64,${avatarB64[tile.fp]}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : (tile.nickname || tile.fp).charAt(0).toUpperCase()}
            </button>
            <div style={{ fontWeight: 700, color: c.heading, marginTop: 12, fontSize: 15 }}>{tile.label}</div>
            <div style={{ fontSize: 11, color: c.muted, marginTop: 2 }}>
              {isScreen
                ? 'aguardando o primeiro quadro…'
                : tile.localPreviewUnavailable
                  ? 'câmera ativa no motor nativo — prévia indisponível nesta tela'
                  : tile.isLocal
                    ? 'sua câmera está desligada'
                    : tile.cameraOn === false
                      ? 'câmera desligada'
                      : 'conectando o vídeo…'}
            </div>
          </div>
        )}
      </div>

      {}
      {isScreen ? (
        <span
          title={`Tela compartilhada por ${tile.nickname}`}
          style={{
            position: 'absolute', top: 8, left: 8, background: c.green, color: '#fff',
            fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
          }}
        >
          {tile.isLocal ? 'SUA TELA' : `TELA • ${tile.nickname}`}
        </span>
      ) : (
        tile.cameraOn && (
          <span
            title="Câmera ativa"
            style={{
              position: 'absolute', top: 8, left: 8, background: '#5865f2', color: '#fff',
              fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
            }}
          >
            CÂMERA
          </span>
        )
      )}

      {!isScreen && !tile.cameraOn && (
        <span
          title="Câmera desligada"
          aria-label="Câmera desligada"
          style={{ position: 'absolute', top: 8, left: 8, background: '#111a', color: '#fff', fontSize: 10, padding: '3px 6px', borderRadius: 4 }}
        >
          ▣̸
        </span>
      )}

      {tile.disconnected && (
        <span style={{ position: 'absolute', top: 8, right: 8, background: '#faa61a', color: '#fff', fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 4 }}>
          RECONECTANDO…
        </span>
      )}

      {}
      <div
        style={{
          position: 'absolute',
          right: touch ? 6 : 8,
          bottom: touch ? 6 : undefined,
          top: touch ? undefined : 38,
          display: 'flex',
          flexDirection: touch ? 'row' : 'column',
          gap: 4,
        }}
      >
        {onPin && (
          <button
            type="button"
            aria-label={pinned ? `Desafixar ${tile.label}` : `Fixar ${tile.label}`}
            title={pinned ? 'Desafixar' : 'Fixar'}
            onClick={(e) => { e.stopPropagation(); onPin(tile.id) }}
            style={{
              border: '1px solid #ffffff44', borderRadius: 6,
              background: pinned ? c.accent : '#111c',
              color: '#fff', cursor: 'pointer',
              width: touch ? 34 : 26, height: touch ? 34 : 26, padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon d={Icons.pin} size={touch ? 16 : 13} />
          </button>
        )}
        {onExpand && (
          <button
            type="button"
            aria-label={
              expanded
                ? (isScreen ? 'Recolher tela cheia' : 'Recolher participante')
                : (isScreen ? 'Ver tela compartilhada em tela cheia' : pinned ? 'Ampliar participante fixado' : `Ampliar ${tile.label}`)
            }
            title={expanded ? 'Recolher (Esc)' : 'Tela cheia'}
            onClick={(e) => { e.stopPropagation(); onExpand(tile.id) }}
            style={{
              border: '1px solid #ffffff44', borderRadius: 6,
              background: expanded ? c.accent : '#111c',
              color: '#fff', cursor: 'pointer',
              width: touch ? 34 : 26, height: touch ? 34 : 26, padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon d={expanded ? Icons.collapse : Icons.expand} size={touch ? 16 : 13} />
          </button>
        )}
      </div>

      {
}
      {!tile.isLocal && (tile.audioStream ?? tile.stream) && (
        <audio
          autoPlay
          playsInline
          data-call-audio-fp={audioKey}
          aria-hidden
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none', left: -9999 }}
          ref={(el: HTMLAudioElement | null) => {
            audioRef.current = el
            attachStream(el, tile.audioStream ?? tile.stream)
            if (el) applyParticipantPlayback(el, audioKey, callDeafened)
          }}
        />
      )}

      {
}
      {showAudioControls && !tile.isLocal && tile.hasAudio && (
        <ParticipantAudioControls
          fp={audioKey}
          nickname={isScreen ? `${tile.nickname} (tela)` : tile.nickname}
          callDeafened={callDeafened}
        />
      )}

      {!isScreen && !thumbnail && (
        <div style={{ position: 'absolute', bottom: 8, left: 8, right: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,.7)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tile.label} {tile.isLocal ? '(você)' : ''}{' '}
            <Icon d={tile.muted ? Icons.micOff : Icons.mic} size={12} />
          </span>
          {tile.speaking && <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.green, boxShadow: `0 0 6px ${c.green}` }} />}
          {tile.connectionQuality && (
            <span
              title={`qualidade: ${tile.qualityLabel ?? tile.connectionQuality}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 2,
                fontSize: 9, fontWeight: 800, color: '#fff',
                textShadow: '0 1px 2px rgba(0,0,0,.7)',
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: tile.connectionQuality === 'good' ? '#23a559' : tile.connectionQuality === 'medium' ? '#f0b232' : '#f23f42',
              }} />
              {tile.qualityLabel ?? tile.connectionQuality}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export default CallTile
