export type CallTileKind = 'participant' | 'screen'

export interface CallTileParticipantInput {
  fp: string
  nickname?: string
  stream?: MediaStream | null
  screenStream?: MediaStream | null
  videoUrl?: string | null
  screenVideoUrl?: string | null
  sharing?: boolean
  cameraOn?: boolean
  muted?: boolean
  speaking?: boolean
  disconnected?: boolean
}

export interface CallTileLocalInput {
  stream?: MediaStream | null
  screenStream?: MediaStream | null
  sharing?: boolean
  cameraOn?: boolean
  muted?: boolean
  nativeMedia?: boolean
}

export interface BuildCallTilesInput {
  participants?: CallTileParticipantInput[] | null
  myFp?: string | null
  local?: CallTileLocalInput | null
}

export interface CallTile {
  id: string
  kind: CallTileKind
  fp: string
  nickname: string
  label: string
  stream?: MediaStream
  audioStream?: MediaStream
  audioKey?: string
  videoUrl?: string
  isLocal: boolean
  sharing: boolean
  muted: boolean
  speaking: boolean
  disconnected: boolean
  cameraOn: boolean
  localPreviewUnavailable: boolean
}

export function participantTileId(fp: string): string {
  return `p:${fp}`
}

export function screenTileId(fp: string): string {
  return `s:${fp}`
}

export function screenTileLabel(nickname: string, isLocal: boolean): string {
  const who = (nickname || '').trim()
  if (isLocal) return 'Sua tela'
  return who ? `Tela de ${who}` : 'Tela compartilhada'
}

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

export function buildCallTiles(input: BuildCallTilesInput): CallTile[] {
  const myFp = typeof input.myFp === 'string' && input.myFp ? input.myFp : null
  const local = input.local ?? null
  const participants = Array.isArray(input.participants) ? input.participants : []

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
      sharing: pickBoolean(raw.sharing, prev.sharing),
      cameraOn: pickBoolean(raw.cameraOn, prev.cameraOn),
      muted: pickBoolean(raw.muted, prev.muted),
      speaking: pickBoolean(raw.speaking, prev.speaking),
      disconnected: pickBoolean(raw.disconnected, prev.disconnected),
    })
  }

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

    const cameraConsumedByScreen = !isLocal && !!fallbackScreen && !remoteScreenStream
    const audioOwnerIsScreen = !isLocal && cameraConsumedByScreen
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
      audioStream: isLocal || audioOwnerIsScreen
        ? undefined
        : (remoteCameraStream ?? cameraStream ?? undefined) ?? undefined,
      audioKey: participantTileId(p.fp),
      videoUrl: participantVideoUrl,
      isLocal,
      sharing,
      muted: isLocal ? pickBoolean(local?.muted, p.muted) : pickBoolean(p.muted),
      speaking: p.speaking === true,
      disconnected: p.disconnected === true && !isLocal,
      cameraOn,
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
        audioStream: audioOwnerIsScreen ? (screenStream ?? undefined) : undefined,
        audioKey: screenTileId(p.fp),
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

  tiles.sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1
    if (a.fp !== b.fp) return a.fp < b.fp ? -1 : 1
    return a.kind === b.kind ? 0 : a.kind === 'participant' ? -1 : 1
  })
  return tiles
}

// Seção 1: resolveTileId
export function resolveTileId(id: string | null | undefined, tiles: CallTile[]): string | null {
  if (!id) return null
  return tiles.some((t) => t.id === id) ? id : null
}

export function sortTilesForPin(tiles: CallTile[], pinnedId: string | null): CallTile[] {
  if (!pinnedId) return tiles
  const index = tiles.findIndex((t) => t.id === pinnedId)
  if (index < 0) return tiles
  return [tiles[index], ...tiles.slice(0, index), ...tiles.slice(index + 1)]
}

export function tilesKey(tiles: CallTile[]): string {
  return tiles.map((t) => t.id).join('|')
}

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
