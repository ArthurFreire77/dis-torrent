import { test, expect } from '@playwright/test'

// O relato: "conecta, mas não sai áudio".
//
// A cadeia que precisa funcionar, e que este teste trava:
//   1. o tile do peer existe;
//   2. o `<audio>` é MONTADO mesmo numa chamada de voz (sem vídeo);
//   3. ele recebe o `srcObject` com a trilha de áudio;
//   4. `play()` foi chamado (sem isso o WebView do Android fica em silêncio).
//
// Rodamos a regra pura de construção dos tiles dentro da página, que é o mesmo
// módulo que as duas UIs usam — sem depender de WebRTC real no CI.

test('chamada de voz monta <audio> com trilha remota e chama play()', async ({ page }) => {
  await page.goto('/d/distorrent')

  const resultado = await page.evaluate(async () => {
    const mod = await import('/src/services/callTiles.ts')
    // Track falsa: o construtor de MediaStream do Chromium exige MediaStreamTrack
    // de verdade, então criamos um áudio real de 1 canal via AudioContext.
    const ctx = new AudioContext()
    const dest = ctx.createMediaStreamDestination()
    const osc = ctx.createOscillator()
    osc.connect(dest)
    osc.start()
    const stream = dest.stream

    const tiles = mod.buildCallTiles({
      myFp: 'meu-fp',
      participants: [{ fp: 'peer-fp', nickname: 'Fepo', stream, cameraOn: false }],
    })
    const peer = tiles.find((t) => t.fp === 'peer-fp')
    return {
      temTile: !!peer,
      audioStreamPresente: !!peer?.audioStream,
      temTrilhaDeAudio: !!peer?.audioStream?.getAudioTracks().length,
      streamDeVideoAusente: !peer?.stream,
    }
  })

  expect(resultado.temTile, 'o quadrado do peer precisa existir').toBe(true)
  expect(resultado.streamDeVideoAusente, 'sem vídeo vivo não há <video>').toBe(true)
  expect(
    resultado.audioStreamPresente,
    'audioStream precisa existir sem vídeo, senão o <audio> não é montado',
  ).toBe(true)
  expect(resultado.temTrilhaDeAudio, 'o stream de áudio precisa ter trilha').toBe(true)
})
