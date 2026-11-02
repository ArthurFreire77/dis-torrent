// callRemoteTracks — mescla as tracks que chegam de um peer num único stream.
//
// POR QUE EXISTE: um peer envia UM vídeo por vez (câmera OU tela — as duas
// dividem a mesma m-line, ver `toggleCamera`). Ao trocar de fonte, o WebRTC
// entrega uma track NOVA na mesma transceiver`; quem só fazia `addTrack` deixava
// a track antiga no stream e o `<video>` toca SEMPRE a PRIMEIRA. Resultado:
// o quadrado da TELA mostrava a câmera antiga — "liguei a câmera e ela foi para
// o lugar da tela". Aqui a track de vídeo nova substitui a anterior.
//
// Módulo puro (sem DOM/Tauri) para rodar em node:test.

/** O que a mesclagem precisa enxergar de uma track. */
export interface RemoteTrackLike {
  id: string
  kind: string
}

/** O que a mesclagem precisa enxergar de um stream. */
export interface RemoteStreamLike<T extends RemoteTrackLike> {
  getTracks(): T[]
  addTrack(track: T): void
  removeTrack(track: T): void
}

/**
 * Acrescenta as tracks que faltam, substituindo a de vídeo quando houver outra.
 * Devolve `true` se o stream mudou (a UI usa isso para re-renderizar).
 */
export function mergeRemoteStream<T extends RemoteTrackLike>(
  target: RemoteStreamLike<T>,
  incoming: RemoteStreamLike<T>,
): boolean {
  let mudou = false
  for (const track of incoming.getTracks()) {
    const jaTem = target.getTracks().some((t) => t.id === track.id)
    if (jaTem) continue
    if (track.kind === 'video') {
      // Um vídeo por peer: o novo é o que está sendo enviado agora.
      for (const antiga of target.getTracks().filter((t) => t.kind === 'video')) {
        try { target.removeTrack(antiga) } catch { /* track já saiu: segue */ }
      }
    }
    try {
      target.addTrack(track)
      mudou = true
    } catch { /* track duplicada/fechada: ignora */ }
  }
  return mudou
}
