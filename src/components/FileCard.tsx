// CARTÃO DE ARQUIVO — um componente para os DOIS shells.
//
// Antes o desktop tinha um cartão inline (dentro do `renderFile` do
// MessageList) e o celular tinha outro (`FileCard` em MobileShell). Eles
// divergiam em tudo: o desktop não mostrava prévia de imagem/vídeo, o mobile não
// mostrava velocidade, o texto do botão era "Baixar (43%)" num e "Salvar" no
// outro, e nenhum dos dois dizia por que um download tinha parado.
//
// Aqui a regra é única:
//   • prévia inline de imagem/vídeo (o mobile já fazia);
//   • barra + porcentagem + VELOCIDADE embaixo do envio (o pedido);
//   • botão "Baixar" que só salva em Downloads — nada baixa por engano;
//   • erro do download visível (motivo real, não "0%" parado).
//
// Componente de APRESENTAÇÃO: recebe tudo pronto do shell (que é quem conhece o
// swarm e a fila). Assim dá para testar sem WebView/Tauri.

import type { ReactNode } from 'react'
import { Ic } from '../shared/icons'
import { formatFileSize } from '../shared/bytes'
import { isVideoName } from '../services/fileRules'
import { downloadButtonLabel, formatSpeed, type FileCardProgress } from './fileCardRules'

export type { FileCardProgress }
export { downloadButtonLabel, formatSpeed }

export interface FileCardPalette {
  text: string
  heading: string
  muted: string
  accent: string
  input: string
  border: string
  main: string
  green: string
  red: string
  yellow: string
}

export function FileCard({
  name,
  size,
  chunks,
  mine,
  mstatus,
  announced,
  previewUrl,
  progress,
  pal,
  onDownload,
  onRetry,
  extra,
}: {
  name: string
  size: number
  chunks: number
  /** Enviei eu? (o "Tentar novamente" da mensagem só aparece nesse caso). */
  mine?: boolean
  /** Status da MENSAGEM (para o reenvio em caso de falha de envio). */
  mstatus?: string
  /** O anúncio do swarm já chegou? (= o arquivo é alcançável) */
  announced: boolean
  previewUrl?: string
  progress?: FileCardProgress
  pal: FileCardPalette
  onDownload: () => void
  onRetry?: () => void
  /** Rodapé extra do shell (ex.: botão "Painel de downloads"). */
  extra?: ReactNode
}) {
  const done = (progress?.pct ?? 0) >= 100 && progress?.status === 'completed'
  const pct = Math.round(progress?.pct ?? 0)
  const showBar = !!announced && !done
  const failed = progress?.status === 'failed'
  const paused = progress?.status === 'paused'
  const video = isVideoName(name)

  return (
    <div
      style={{
        marginTop: 6,
        background: pal.input,
        border: `1px solid ${failed ? pal.red : pal.border}`,
        borderRadius: 12,
        padding: '10px 12px',
        maxWidth: 420,
        minWidth: 0,
      }}
    >
      {/* PRÉVIA: imagem/vídeo aparece aqui, sem precisar salvar. */}
      {previewUrl && video && (
        <video
          src={previewUrl}
          controls
          preload="metadata"
          style={{ width: '100%', maxHeight: 340, borderRadius: 10, display: 'block', marginBottom: 10, background: '#000' }}
        />
      )}
      {previewUrl && !video && (
        <img
          src={previewUrl}
          alt={name}
          style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 10, display: 'block', marginBottom: 10 }}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{ display: 'flex', flexShrink: 0, color: pal.muted }}>
          <Ic name="attach" size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            title={name}
            style={{ fontSize: 13, fontWeight: 800, color: pal.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {name}
          </div>
          <div style={{ fontSize: 11, color: pal.muted, marginTop: 2 }}>
            {formatFileSize(size)} · {chunks} {chunks === 1 ? 'bloco' : 'blocos'}
          </div>
        </div>
      </div>

      {/* BARRA + % + VELOCIDADE. É o "embaixo do envio" pedido: mostra o que
          está acontecendo agora, não um número congelado. */}
      {showBar && (
        <div style={{ marginTop: 8 }}>
          <div style={{ height: 6, background: pal.main, borderRadius: 99, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max(2, pct)}%`,
                height: '100%',
                background: failed ? pal.red : paused ? pal.yellow : pal.accent,
                transition: 'width .3s',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 11 }}>
            <span style={{ fontWeight: 800, color: failed ? pal.red : paused ? pal.yellow : pal.text, fontVariantNumeric: 'tabular-nums' }}>
              {pct}%
            </span>
            <span style={{ color: pal.muted }}>·</span>
            <span style={{ color: pal.muted, fontVariantNumeric: 'tabular-nums' }}>
              {paused ? 'pausado' : failed ? 'parou' : formatSpeed(progress?.speed ?? 0)}
            </span>
            {!failed && !paused && progress?.status === 'downloading' && (
              <span style={{ color: pal.muted, marginLeft: 'auto' }}>
                {formatFileSize(Math.round((size * pct) / 100))} de {formatFileSize(size)}
              </span>
            )}
          </div>
        </div>
      )}

      {!announced && (
        <div style={{ fontSize: 11, color: pal.muted, marginTop: 6 }}>
          aguardando o anúncio do arquivo…
        </div>
      )}
      {failed && progress?.error && (
        <div style={{ fontSize: 11, color: '#ff9c9c', marginTop: 6, lineHeight: 1.5 }}>{progress.error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          onClick={onDownload}
          disabled={!announced}
          title={
            !announced
              ? 'o anúncio deste arquivo ainda não chegou'
              : done
                ? 'salvar na pasta Downloads'
                : 'baixar do swarm e salvar em Downloads'
          }
          style={{
            background: pal.accent,
            color: '#fff',
            border: 'none',
            padding: '7px 12px',
            borderRadius: 8,
            cursor: announced ? 'pointer' : 'not-allowed',
            fontSize: 12,
            fontWeight: 800,
            opacity: announced ? 1 : 0.55,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Ic name={done ? 'save' : 'download'} size={14} />
          {downloadButtonLabel(announced, done, progress, !!previewUrl)}
        </button>
        {extra}
        {mine && mstatus === 'failed' && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            style={{
              background: 'transparent',
              color: pal.muted,
              border: `1px solid ${pal.border}`,
              padding: '7px 12px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Reenviar mensagem
          </button>
        )}
      </div>
    </div>
  )
}
