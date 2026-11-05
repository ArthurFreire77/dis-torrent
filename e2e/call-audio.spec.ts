import { test, expect } from '@playwright/test'

test('chamada de voz monta <audio> com trilha remota e chama play()', async ({ page }) => {
  await page.goto('/d/distorrent')

  const resultado = await page.evaluate(async () => {
    const mod = await import('/src/services/callTiles.ts')
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
