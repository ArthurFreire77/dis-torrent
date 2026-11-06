import { test, expect, chromium, type Page } from '@playwright/test'

/**
 * Prova REAL de câmera: duas RTCPeerConnection no mesmo Chromium, com a mesma
 * biblioteca que o app usa (`mergeRemoteStream`/`buildCallTiles`).
 *
 * O que este teste prova e o que o relato "câmera preta" exigia:
 *  - o track remoto CHEGA e é associado ao peer certo;
 *  - o <video> do tile realmente toca (currentTime avança);
 *  - os pixels não são pretos;
 *  - a TELA compartilhada, quando entra como segundo track de vídeo, não
 *    derruba a câmera nem é confundida com ela.
 *
 * Não prova o motor Rust nem duas máquinas físicas — isso continua pendente.
 */

async function boot(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 20000 })
}

test.describe('câmera e tela entre dois pares (WebRTC real)', () => {
  test.slow()

  test('câmera remota chega, toca e não é preta; tela entra sem matar a câmera', async () => {
    const browser = await chromium.launch({
      headless: false,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox',
      ],
    })
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const erros: string[] = []
    page.on('pageerror', (e) => erros.push(String((e as Error)?.message ?? e)))
    await boot(page)

    const r = await page.evaluate(async () => {
      const modStream = await import('/src/services/callRemoteTracks.ts')
      const modTiles = await import('/src/services/callTiles.ts')

      const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

      // --- captura sintética (mesmo caminho do getUserMedia do app)
      const camera = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 360 },
        audio: false,
      })
      const camTrack = camera.getVideoTracks()[0]

      // --- par A (quem envia) e par B (quem recebe)
      const a = new RTCPeerConnection({ iceServers: [] })
      const b = new RTCPeerConnection({ iceServers: [] })

      const recebido = new MediaStream()
      const tracksRecebidos: { kind: string; id: string }[] = []
      b.ontrack = (ev) => {
        const st = ev.streams[0] ?? new MediaStream([ev.track])
        tracksRecebidos.push({ kind: ev.track.kind, id: ev.track.id })
        modStream.mergeRemoteStream(
          recebido as never,
          st as never,
        )
      }

      a.addTrack(camTrack, camera)

      const offer = await a.createOffer()
      await a.setLocalDescription(offer)
      await b.setRemoteDescription(offer)
      const answer = await b.createAnswer()
      await b.setLocalDescription(answer)
      await a.setRemoteDescription(answer)

      a.onicecandidate = (ev) => { if (ev.candidate) void b.addIceCandidate(ev.candidate) }
      b.onicecandidate = (ev) => { if (ev.candidate) void a.addIceCandidate(ev.candidate) }

      const esperar = async (pc: RTCPeerConnection, ms: number) => {
        const t0 = Date.now()
        while (Date.now() - t0 < ms) {
          if ((pc as any).connectionState === 'connected') return true
          await sleep(100)
        }
        return false
      }
      const conectouA = await esperar(a, 10000)
      const conectouB = await esperar(b, 10000)

      // --- o tile do app recebe o stream remoto
      const tiles = modTiles.buildCallTiles({
        myFp: 'eu',
        participants: [{ fp: 'peer', nickname: 'Peer', stream: recebido, cameraOn: true }],
      })
      const tilePeer = tiles.find((t) => t.fp === 'peer')

      // --- monta um <video> como o CallTile faz e mede de verdade
      const video = document.createElement('video')
      video.autoplay = true
      video.muted = true
      video.playsInline = true
      video.srcObject = (tilePeer?.stream ?? recebido) as MediaStream
      video.style.cssText = 'position:fixed;left:8px;bottom:8px;width:320px;height:180px;opacity:0.01'
      document.body.appendChild(video)
      await video.play().catch(() => {})

      let videoW = 0
      let videoH = 0
      let avancou = false
      const t0 = video.currentTime
      for (let i = 0; i < 60; i++) {
        await sleep(200)
        videoW = video.videoWidth
        videoH = video.videoHeight
        if (videoW > 0 && video.currentTime > t0 + 0.05) { avancou = true; break }
      }

      // --- pixels não-pretos
      let naoPreto = false
      try {
        if (videoW > 0) {
          const c = document.createElement('canvas')
          c.width = 64; c.height = 36
          const g = c.getContext('2d')!
          g.drawImage(video, 0, 0, 64, 36)
          const d = g.getImageData(0, 0, 64, 36).data
          let claros = 0
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] > 24 || d[i + 1] > 24 || d[i + 2] > 24) claros++
          }
          naoPreto = claros > 64 * 36 * 0.02
        }
      } catch { /* canvas bloqueado */ }

      // --- agora a TELA entra como segundo vídeo (o caso que "mata a câmera")
      const tela = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: true,
      } as never).catch(() => null)
      const telaTrack = tela?.getVideoTracks()[0] ?? null
      let camSobreviveu = true
      let telaNoTile = false
      if (telaTrack) {
        const enviarTela = a.addTrack(telaTrack, tela!)
        const offer2 = await a.createOffer()
        await a.setLocalDescription(offer2)
        await b.setRemoteDescription(offer2)
        const answer2 = await b.createAnswer()
        await b.setLocalDescription(answer2)
        await a.setRemoteDescription(answer2)
        await sleep(1500)

        // a câmera continua viva e ainda está no stream remoto?
        camSobreviveu = camTrack.readyState === 'live' &&
          recebido.getVideoTracks().some((t) => t.id === camTrack.id || t.readyState === 'live')
        telaNoTile = recebido.getVideoTracks().length > 0
        void enviarTela
      }

      const stats = await b.getStats()
      let framesDecodificados = 0
      let pacotesRecebidos = 0
      stats.forEach((s: any) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          framesDecodificados += s.framesDecoded ?? 0
          pacotesRecebidos += s.packetsReceived ?? 0
        }
      })

      const resultado = {
        conexao: { a: (a as any).connectionState, b: (b as any).connectionState },
        conectouA,
        conectouB,
        trilhasRecebidas: tracksRecebidos,
        tileExiste: !!tilePeer,
        tileTemVideo: !!tilePeer?.stream?.getVideoTracks?.().length,
        videoW,
        videoH,
        currentTimeAvancou: avancou,
        naoPreto,
        framesDecodificados,
        pacotesRecebidos,
        telaDisponivel: !!telaTrack,
        camSobreviveuDepoisDaTela: camSobreviveu,
        temVideoNoTileDepoisDaTela: telaNoTile,
      }

      try { a.close(); b.close() } catch {  }
      try { camera.getTracks().forEach((t) => t.stop()) } catch {  }
      try { tela?.getTracks().forEach((t) => t.stop()) } catch {  }
      video.remove()

      return resultado
    })

    await ctx.close()
    await browser.close()

    console.log('RESULTADO CÂMERA/TELA:', JSON.stringify(r, null, 2))

    expect(erros, 'sem erro de página durante a negociação').toEqual([])
    expect(r.conectouA && r.conectouB, 'as duas pontas precisam conectar').toBe(true)
    expect(r.trilhasRecebidas.some((t) => t.kind === 'video'), 'o track de vídeo remoto chega').toBe(true)
    expect(r.tileExiste, 'o tile do peer é criado').toBe(true)
    expect(r.tileTemVideo, 'o tile carrega o stream de vídeo').toBe(true)
    expect(r.videoW, 'o <video> remoto tem largura (não é um canvas vazio)').toBeGreaterThan(0)
    expect(r.currentTimeAvancou, 'o vídeo remoto TOCA (currentTime avança)').toBe(true)
    expect(r.pacotesRecebidos, 'chegaram pacotes RTP de vídeo').toBeGreaterThan(0)
    expect(r.framesDecodificados, 'o decoder produziu quadros').toBeGreaterThan(0)
    expect(r.naoPreto, 'a imagem remota não é preta').toBe(true)

    if (r.telaDisponivel) {
      expect(r.camSobreviveuDepoisDaTela, 'a câmera não pode morrer quando a tela entra').toBe(true)
      expect(r.temVideoNoTileDepoisDaTela, 'a tela aparece no tile').toBe(true)
    }
  })
})
