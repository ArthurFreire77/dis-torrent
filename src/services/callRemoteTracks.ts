export interface RemoteTrackLike {
  id: string
  kind: string
}

export interface RemoteStreamLike<T extends RemoteTrackLike> {
  getTracks(): T[]
  addTrack(track: T): void
  removeTrack(track: T): void
}

export function mergeRemoteStream<T extends RemoteTrackLike>(
  target: RemoteStreamLike<T>,
  incoming: RemoteStreamLike<T>,
): boolean {
  let mudou = false
  for (const track of incoming.getTracks()) {
    const jaTem = target.getTracks().some((t) => t.id === track.id)
    if (jaTem) continue
    if (track.kind === 'video') {
      for (const antiga of target.getTracks().filter((t) => t.kind === 'video')) {
        try { target.removeTrack(antiga) } catch {  }
      }
    }
    try {
      target.addTrack(track)
      mudou = true
    } catch {  }
  }
  return mudou
}
