export interface CallRoomView {
  convId: string
  callId: string
  kind: 'voice' | 'video'
  hostFp: string
  participants: string[]
}

type Listener = (rooms: Map<string, CallRoomView>) => void

function toView(raw: any): CallRoomView | null {
  if (!raw || typeof raw !== 'object') return null
  const convId = typeof raw.conv_id === 'string' ? raw.conv_id : ''
  if (!convId) return null
  const participants = Array.isArray(raw.participants)
    ? raw.participants.filter((fp: unknown): fp is string => typeof fp === 'string' && !!fp)
    : []
  return {
    convId,
    callId: typeof raw.call_id === 'string' ? raw.call_id : '',
    kind: raw.kind === 'video' ? 'video' : 'voice',
    hostFp: typeof raw.host_fp === 'string' ? raw.host_fp : '',
    participants,
  }
}

export class CallRoomStore {
  private rooms = new Map<string, CallRoomView>()
  private listeners = new Set<Listener>()

  apply(raw: any): boolean {
    const view = toView(raw)
    if (!view) return false
    if (raw?.state === 'closed') {
      if (!this.rooms.delete(view.convId)) return false
    } else {
      if (!view.callId) return false
      const prev = this.rooms.get(view.convId)
      if (
        prev &&
        prev.callId === view.callId &&
        prev.hostFp === view.hostFp &&
        prev.kind === view.kind &&
        prev.participants.length === view.participants.length &&
        prev.participants.every((fp, i) => fp === view.participants[i])
      ) {
        return false
      }
      this.rooms.set(view.convId, view)
    }
    this.emit()
    return true
  }

  reset(list: any[]): void {
    const next = new Map<string, CallRoomView>()
    for (const raw of Array.isArray(list) ? list : []) {
      const view = toView(raw)
      if (view && view.callId && raw?.state !== 'closed') next.set(view.convId, view)
    }
    this.rooms = next
    this.emit()
  }

  get(convId: string): CallRoomView | null {
    return this.rooms.get(convId) ?? null
  }

  snapshot(): Map<string, CallRoomView> {
    return new Map(this.rooms)
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private emit() {
    const snap = this.snapshot()
    for (const cb of this.listeners) {
      try { cb(snap) } catch {  }
    }
  }
}

export const callRooms = new CallRoomStore()

export const ROOM_SYNC_MS = 10_000

export async function syncCallRooms(
  list: () => Promise<unknown[]>,
): Promise<void> {
  try {
    const l = await list()
    callRooms.reset(Array.isArray(l) ? l : [])
  } catch {  }
}

export function roomSummary(room: CallRoomView | null, nameOf: (fp: string) => string): string | null {
  if (!room) return null
  const n = room.participants.length
  if (n === 0) return 'chamada em andamento'
  const quem = room.participants
    .slice(0, 2)
    .map((fp) => nameOf(fp) || fp.slice(0, 6))
    .join(', ')
  return `${n} ${n === 1 ? 'pessoa' : 'pessoas'} na chamada — ${quem}${n > 2 ? ` +${n - 2}` : ''}`
}

/**
 * Tem alguém além de mim para entrar? Sem isso o botão verde "Entrar" aparece
 * numa sala só comigo, tenta parear e fica preso em "entrando…".
 */
export function salaTemAlguemParaEntrar(room: CallRoomView | null, myFp: string | null | undefined): boolean {
  if (!room) return false
  const me = typeof myFp === 'string' ? myFp : ''
  if (room.participants.some((fp) => fp && fp !== me)) return true
  return !!room.hostFp && room.hostFp !== me
}
