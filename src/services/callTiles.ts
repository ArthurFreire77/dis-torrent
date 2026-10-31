// callTiles — modelo ÚNICO dos quadrados da chamada (pessoa e tela).
// Separa identidade do PARTICIPANTE (`fp`) da TRANSMISSÃO (`id`: `p:<fp>`
// câmera, `s:<fp>` tela) — antes o mesmo campo `stream` fazia tela e câmera
// brigarem, o tile local dependia de stream remoto inexistente e fixar/expandir
// não distinguia a tela da pessoa. Módulo puro (sem React/DOM/Tauri), testável
// em node:test e compartilhado pelas duas UIs.

/** Tipo de transmissão representada pelo quadrado. */
export type CallTileKind = 'participant' | 'screen'

/** Entrada vinda do `CallState.participants` (campos opcionais de propósito). */
export interface CallTileParticipantInput {
  fp: string
  nickname?: string
  /** Câmera/áudio remoto. No caminho nativo pode não existir (frames em JPEG). */
  stream?: MediaStream | null
  /** Tela remota quando chega num m-line próprio (dois vídeos simultâneos). */
  screenStream?: MediaStream | null
  /** Último frame JPEG decodificado pelo core (Linux nativo). */
  videoUrl?: string | null
  /** Último frame de TELA no caminho nativo (quando a fonte é a tela). */
  screenVideoUrl?: string | null
  sharing?: boolean
  /** Câmera LIGADA do outro lado; `false` = desligada, `undefined` = sem info. */
  cameraOn?: boolean
  muted?: boolean
  speaking?: boolean
  disconnected?: boolean
}

/** Tudo que a UI sabe sobre a própria mídia (fonte da verdade do "eu"). */
export interface CallTileLocalInput {
  stream?: MediaStream | null
  screenStream?: MediaStream | null
  sharing?: boolean
  cameraOn?: boolean
  muted?: boolean
  /** `true` no caminho nativo (Linux): não há MediaStream local na página. */
  nativeMedia?: boolean
}

export interface BuildCallTilesInput {
  participants?: CallTileParticipantInput[] | null
  myFp?: string | null
  local?: CallTileLocalInput | null
}

/** Quadrado renderizável. `id` é a identidade ESTÁVEL da transmissão. */
export interface CallTile {
  /** `p:<fp>` (pessoa) ou `s:<fp>` (tela). Nunca muda enquanto durar. */
  id: string
  kind: CallTileKind
  /** Dono da transmissão — a MESMA pessoa nos dois quadrados. */
  fp: string
  nickname: string
  /** Nome exibido (na tela: "Tela de Fulano" / "Sua tela"). */
  label: string
  /** Stream a desenhar; ausente = avatar (pessoa) ou "aguardando" (tela). */
  stream?: MediaStream
  /** Frame JPEG (caminho nativo) quando não há MediaStream. */
  videoUrl?: string
  isLocal: boolean
  sharing: boolean
  muted: boolean
  speaking: boolean
  disconnected: boolean
  /** Câmera ligada (para o selo e a foto de perfil sumir). */
  cameraOn: boolean
  /** Caminho nativo jura que há mídia viva, mas a página não recebe frames locais. */
  localPreviewUnavailable: boolean
}

export function participantTileId(fp: string): string {
  return `p:${fp}`
}

export function screenTileId(fp: string): string {
  return `s:${fp}`
}

/** Nome do quadro da tela. Mantém a autoria visível (item 2.7 da spec). */
export function screenTileLabel(nickname: string, isLocal: boolean): string {
  const who = (nickname || '').trim()
  if (isLocal) return 'Sua tela'
  return who ? `Tela de ${who}` : 'Tela compartilhada'
}

/** Um MediaStream só conta como mídia se tiver trilha VIVA de vídeo. */
export function streamHasLiveVideo(stream: MediaStream | null | undefined): boolean {
  try {
    if (!stream || typeof stream.getVideoTracks !== 'function') return false
    return stream.getVideoTracks().some((t) => t.readyState === 'live')
  } catch {
    return false
  }
}

function pickBoolean(...values: Array<boolean | undefined>): boolean {
  for (const v of values) {
    if (typeof v === 'boolean') return v
  }
  return false
}

function pickString(...values: Array<string | null | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}

/**
 * Consolida participantes em quadrados: dedupe por `fp`, o "eu" usa mídia
 * local, tela só existe com `sharing`, e câmera/tela nunca repetem o mesmo
 * stream nos dois quadrados (testado em `tests/callTiles.test.ts`).
 */
export function buildCallTiles(input: BuildCallTilesInput): CallTile[] {
  const myFp = typeof input.myFp === 'string' && input.myFp ? input.myFp : null
  const local = input.local ?? null
  const participants = Array.isArray(input.participants) ? input.participants : []

  // Dedupe com merge: prefere o registro com stream; evento mais recente vence.
  const byFp = new Map<string, CallTileParticipantInput>()
  for (const raw of participants) {
    if (!raw || typeof raw.fp !== 'string' || !raw.fp) continue
    const prev = byFp.get(raw.fp)
    if (!prev) {
      byFp.set(raw.fp, { ...raw })
      continue
    }
    byFp.set(raw.fp, {
      ...prev,
      ...raw,
      stream: raw.stream ?? prev.stream ?? null,
      screenStream: raw.screenStream ?? prev.screenStream ?? null,
      videoUrl: raw.videoUrl ?? prev.videoUrl ?? null,
      screenVideoUrl: raw.screenVideoUrl ?? prev.screenVideoUrl ?? null,
      nickname: raw.nickname || prev.nickname,
      // `undefined` do evento novo não apaga estado já conhecido.
      sharing: pickBoolean(raw.sharing, prev.sharing),
      cameraOn: pickBoolean(raw.cameraOn, prev.cameraOn),
      muted: pickBoolean(raw.muted, prev.muted),
      speaking: pickBoolean(raw.speaking, prev.speaking),
      disconnected: pickBoolean(raw.disconnected, prev.disconnected),
    })
  }

  // O "eu" existe mesmo sem roster do motor (chamada nativa entra assim).
  if (myFp && !byFp.has(myFp)) {
    byFp.set(myFp, { fp: myFp, nickname: '' })
  }

  const tiles: CallTile[] = []
  for (const p of byFp.values()) {
    const isLocal = !!myFp && p.fp === myFp
    const nickname = (p.nickname || '').trim() || p.fp.slice(0, 8)
    const cameraOn = isLocal
      ? pickBoolean(local?.cameraOn, p.cameraOn)
      : pickBoolean(p.cameraOn)
    const sharing = isLocal
      ? pickBoolean(local?.sharing, p.sharing)
      : pickBoolean(p.sharing)

    const localCameraStream = isLocal ? local?.stream ?? null : null
    const remoteCameraStream = !isLocal ? p.stream ?? null : null
    const cameraStream = localCameraStream ?? remoteCameraStream

    // Tela: local usa o stream de captura; remota prefere stream dedicado,
    // caindo para o vídeo único do participante.
    const localScreenStream = isLocal ? local?.screenStream ?? null : null
    const remoteScreenStream = !isLocal ? p.screenStream ?? null : null
    const dedicatedScreen = localScreenStream ?? remoteScreenStream
    const fallbackScreen = !dedicatedScreen && sharing ? cameraStream : null
    const screenStream = dedicatedScreen ?? fallbackScreen

    const screenVideoUrl = isLocal
      ? undefined
      : sharing
        ? pickString(p.screenVideoUrl, p.videoUrl)
        : undefined

    // Vídeo único consumido pela tela → quadrado da pessoa fica no avatar
    // (o bug era "dois quadrados com o mesmo vídeo").
    const cameraConsumedByScreen = !isLocal && !!fallbackScreen && !remoteScreenStream
    // LOCAL: vídeo só com câmera LIGADA E trilha viva — as duas juntas são o
    // estado honesto (evita `<video>` preto e frame congelado).
    const participantStream = isLocal
      ? (cameraOn && streamHasLiveVideo(localCameraStream) ? localCameraStream ?? undefined : undefined)
      : (cameraConsumedByScreen || p.cameraOn === false ? undefined : cameraStream ?? undefined)

    const participantVideoUrl = isLocal
      ? undefined
      : cameraConsumedByScreen
        ? undefined
        : pickString(p.videoUrl)

    tiles.push({
      id: participantTileId(p.fp),
      kind: 'participant',
      fp: p.fp,
      nickname,
      label: nickname,
      stream: participantStream ?? undefined,
      videoUrl: participantVideoUrl,
      isLocal,
      sharing,
      muted: isLocal ? pickBoolean(local?.muted, p.muted) : pickBoolean(p.muted),
      speaking: p.speaking === true,
      disconnected: p.disconnected === true && !isLocal,
      cameraOn,
      // Nativo: cameraOn sem stream na página — avisar em vez de retângulo preto.
      localPreviewUnavailable: isLocal && !participantStream && !participantVideoUrl && !!local?.nativeMedia && cameraOn,
    })

    if (sharing) {
      tiles.push({
        id: screenTileId(p.fp),
        kind: 'screen',
        fp: p.fp,
        nickname,
        label: screenTileLabel(nickname, isLocal),
        stream: screenStream ?? undefined,
        videoUrl: screenVideoUrl,
        isLocal,
        sharing: true,
        muted: isLocal ? pickBoolean(local?.muted, p.muted) : pickBoolean(p.muted),
        speaking: false,
        disconnected: p.disconnected === true && !isLocal,
        cameraOn,
        localPreviewUnavailable: isLocal && !screenStream && !screenVideoUrl && !!local?.nativeMedia,
      })
    }
  }

  // Ordem determinística: "eu" primeiro, depois por nome/fp (a UI fixa por cima).
  tiles.sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1
    if (a.fp !== b.fp) return a.fp < b.fp ? -1 : 1
    return a.kind === b.kind ? 0 : a.kind === 'participant' ? -1 : 1
  })
  return tiles
}

/** Mantém fixado/expandido só enquanto a transmissão existir. */
export function resolveTileId(id: string | null | undefined, tiles: CallTile[]): string | null {
  if (!id) return null
  return tiles.some((t) => t.id === id) ? id : null
}

/** Coloca o fixado em primeiro (sem alterar os demais). */
export function sortTilesForPin(tiles: CallTile[], pinnedId: string | null): CallTile[] {
  if (!pinnedId) return tiles
  const index = tiles.findIndex((t) => t.id === pinnedId)
  if (index < 0) return tiles
  return [tiles[index], ...tiles.slice(0, index), ...tiles.slice(index + 1)]
}

/**
 * Chave estável da lista de quadrados — usada por `useEffect` para limpar
 * fixação/expansão quando um stream termina, sem reagir a cada re-render.
 */
export function tilesKey(tiles: CallTile[]): string {
  return tiles.map((t) => t.id).join('|')
}

/** Fixar e expandir são independentes; quadrado que sai devolve o layout. */
export function nextTileSelection(
  action: 'pin' | 'unpin' | 'expand' | 'collapse',
  current: { pinnedId: string | null; expandedId: string | null },
  tileId: string,
): { pinnedId: string | null; expandedId: string | null } {
  switch (action) {
    case 'pin':
      return { pinnedId: tileId, expandedId: current.expandedId }
    case 'unpin':
      return { pinnedId: null, expandedId: current.expandedId }
    case 'expand':
      return { pinnedId: current.pinnedId, expandedId: tileId }
    case 'collapse':
    default:
      return { pinnedId: current.pinnedId, expandedId: null }
  }
}
