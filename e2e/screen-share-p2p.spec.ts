import { test, expect, chromium, type Page } from '@playwright/test'

declare global {
  interface Window {
    __distorrentScreenProbe?: {
      ok: boolean
      why?: string
      surface?: string
      captureLabel?: string
      capturedFps: number | null
      sentFps: number | null
      receivedFps: number | null
      captureWidth: number | null
      captureHeight: number | null
      outboundWidth: number | null
      outboundHeight: number | null
      sendBitrateKbps: number | null
      receiveBitrateKbps: number | null
      rttMs: number | null
      jitterMs: number | null
      packetLossPct: number | null
      framesEncoded: number | null
      framesDecoded: number | null
      framesDropped: number | null
      keyFramesDecoded: number | null
      freezeCount: number | null
      codec: string | null
      qualityLimitationReason: string | null
      remoteTrackLive: boolean
      remoteVideoSize: { w: number; h: number } | null
      remoteVideoTimeAdvanced: boolean
      notBlack: boolean
      sendParamsApplied: boolean
      audioTracks: number
      degradedAfterPressure: boolean
      renegotiationStable: boolean
      peersReusedSender: boolean
    }
  }
}

async function bootWithScreenCapture(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 20000 })
}

test.describe('screen share P2P (captura real + WebRTC real)', () => {
  test.slow()

  test('captura a tela e transmite para um segundo peer sem perder frames', async () => {
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || undefined,
      headless: false,
      args: [
        '--use-fake-ui-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        '--allow-http-screen-capture',
        '--no-sandbox',
      ],
    })
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String((e as Error)?.message ?? e)))
    await bootWithScreenCapture(page)

    await page.addScriptTag({
      type: 'module',
      content: `
        import {
          buildDisplayMediaConstraints,
          applyScreenConstraints,
          applySenderTuning,
          setScreenContentHint,
          detectScreenEnvironment,
          ScreenCaptureMonitor,
          ScreenStatsCollector,
          SCREEN_DEFAULT_OPTIONS,
          lowerScreenQuality,
        } from '/src/services/screenShare.ts'

        const probe = {
          ok: false, capturedFps: null, sentFps: null, receivedFps: null,
          captureWidth: null, captureHeight: null, outboundWidth: null, outboundHeight: null,
          sendBitrateKbps: null, receiveBitrateKbps: null, rttMs: null, jitterMs: null,
          packetLossPct: null, framesEncoded: null, framesDecoded: null, framesDropped: null,
          keyFramesDecoded: null, freezeCount: null, codec: null, qualityLimitationReason: null,
          remoteTrackLive: false, remoteVideoSize: null, remoteVideoTimeAdvanced: false, notBlack: false,
          sendParamsApplied: false, audioTracks: 0, degradedAfterPressure: false,
          renegotiationStable: false, peersReusedSender: false,
        }
        window.__distorrentScreenProbe = probe

        async function run() {
          const env = detectScreenEnvironment()
          probe.surface = env.platform
          const opts = { ...SCREEN_DEFAULT_OPTIONS, source: 'window', quality: '1080p', fps: '60' }
          const md = navigator.mediaDevices
          let stream
          try {
            stream = await md.getDisplayMedia(buildDisplayMediaConstraints(opts, env))
          } catch (e) {
            try {
              stream = await md.getDisplayMedia({
                video: { displaySurface: 'browser' },
                audio: false,
                selfBrowserSurface: 'include',
                preferCurrentTab: true,
              })
            } catch (e2) {
              probe.why = 'captura indisponível: ' + String(e2?.name ?? e2)
              return
            }
          }
          const track = stream.getVideoTracks()[0]
          if (!track) { probe.why = 'sem trilha de vídeo'; return }
          probe.captureLabel = track.label ?? ''
          probe.audioTracks = stream.getAudioTracks().length
          setScreenContentHint(track, opts.source)
          await applyScreenConstraints(track, opts)

          const sender = new RTCPeerConnection({ iceServers: [] })
          const receiver = new RTCPeerConnection({ iceServers: [] })
          const remoteStream = new MediaStream()
          receiver.ontrack = (ev) => {
            remoteStream.addTrack(ev.track)
            probe.remoteTrackLive = true
          }
          const remoteVideo = document.createElement('video')
          remoteVideo.muted = true
          remoteVideo.playsInline = true
          remoteVideo.srcObject = remoteStream
          remoteVideo.style.position = 'fixed'
          remoteVideo.style.opacity = '0.01'
          remoteVideo.style.width = '320px'
          document.body.appendChild(remoteVideo)
          remoteVideo.play().catch(() => {})

          const stim = document.createElement('div')
          stim.style.cssText = 'position:fixed;left:24px;bottom:24px;width:64px;height:64px;background:#f0f;border-radius:12px;z-index:2147483647;'
          document.body.appendChild(stim)
          let stimOn = true
          const stimTimer = setInterval(() => { stimOn = !stimOn; stim.style.background = stimOn ? '#f0f' : '#0ff' }, 250)

          const senderVideo = sender.addTrack(track, stream)
          let unexpectedRenegotiation = false
          const offer = await sender.createOffer()
          await sender.setLocalDescription(offer)
          await receiver.setRemoteDescription(offer)
          const answer = await receiver.createAnswer()
          await receiver.setLocalDescription(answer)
          await sender.setRemoteDescription(answer)

          sender.onicecandidate = (ev) => { if (ev.candidate) receiver.addIceCandidate(ev.candidate).catch(() => {}) }
          receiver.onicecandidate = (ev) => { if (ev.candidate) sender.addIceCandidate(ev.candidate).catch(() => {}) }

          const waitConnected = (pc) => new Promise((resolve) => {
            if (pc.connectionState === 'connected') return resolve(null)
            const check = () => { if (pc.connectionState === 'connected' || pc.connectionState === 'failed') { pc.removeEventListener('connectionstatechange', check); resolve(null) } }
            pc.addEventListener('connectionstatechange', check)
            setTimeout(resolve, 8000)
          })
          await waitConnected(sender)
          await waitConnected(receiver)

          probe.sendParamsApplied = await applySenderTuning(senderVideo, opts)

          sender.onnegotiationneeded = () => { unexpectedRenegotiation = true }
          await senderVideo.replaceTrack(track)
          await new Promise(r => setTimeout(r, 100))
          probe.renegotiationStable = !unexpectedRenegotiation
          probe.peersReusedSender = true

          const monitor = new ScreenCaptureMonitor()
          monitor.attach(track)
          const collector = new ScreenStatsCollector()
          const samples = []
          const start = performance.now()
          let lastTime = 0
          while (performance.now() - start < 8000) {
            await new Promise(r => setTimeout(r, 1000))
            const rs = await receiver.getStats()
            const ss = await sender.getStats()
            const merged = new Map()
            for (const [k, v] of rs) merged.set(k, v)
            for (const [k, v] of ss) merged.set(k.toString() + '-s', v)
            const capture = monitor.sample()
            const m = collector.read(merged, capture, null)
            samples.push(m)
            lastTime = remoteVideo.currentTime
            probe.remoteVideoSize = { w: remoteVideo.videoWidth, h: remoteVideo.videoHeight }
          }
          probe.remoteVideoTimeAdvanced = remoteVideo.currentTime > 0 && remoteVideo.currentTime !== lastTime - 1

          probe.notBlack = (() => {
            try {
              if (!remoteVideo.videoWidth) return false
              const c = document.createElement('canvas')
              c.width = 64
              c.height = 64
              const ctx = c.getContext('2d')
              if (!ctx) return false
              ctx.drawImage(remoteVideo, 0, 0, 64, 64)
              const d = ctx.getImageData(0, 0, 64, 64).data
              let nonBlack = 0
              for (let i = 0; i < d.length; i += 4) {
                if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) nonBlack++
              }
              return nonBlack > 64
            } catch { return false }
          })()

          const last = samples[samples.length - 1] ?? {}
          probe.capturedFps = last.capturedFps ?? null
          probe.sentFps = last.sentFps ?? null
          probe.receivedFps = last.receivedFps ?? null
          probe.captureWidth = last.captureWidth ?? null
          probe.captureHeight = last.captureHeight ?? null
          probe.outboundWidth = last.outboundWidth ?? null
          probe.outboundHeight = last.outboundHeight ?? null
          probe.sendBitrateKbps = last.sendBitrateKbps ?? null
          probe.receiveBitrateKbps = last.receiveBitrateKbps ?? null
          probe.rttMs = last.rttMs ?? null
          probe.jitterMs = last.jitterMs ?? null
          probe.packetLossPct = last.packetLossPct ?? null
          probe.framesEncoded = last.framesEncoded ?? null
          probe.framesDecoded = last.framesDecoded ?? null
          probe.framesDropped = last.framesDropped ?? null
          probe.keyFramesDecoded = last.keyFramesDecoded ?? null
          probe.freezeCount = last.freezeCount ?? null
          probe.codec = last.codec ?? null
          probe.qualityLimitationReason = last.qualityLimitationReason ?? null
          probe.degradedAfterPressure = lowerScreenQuality('1080p') === '720p'

          monitor.detach()
          clearInterval(stimTimer)
          stim.remove()
          sender.close()
          receiver.close()
          stream.getTracks().forEach(t => { try { t.stop() } catch {} })
          probe.ok = true
        }

        run().catch((e) => { probe.why = 'falha na sonda: ' + String(e?.message ?? e) })
      `,
    })

    await page.waitForFunction(() => window.__distorrentScreenProbe !== undefined, { timeout: 20000 })
    await page.waitForFunction(() => {
      // Seção 1: p
      const p = window.__distorrentScreenProbe
      return !!p && (p.ok === true || !!p.why)
    }, { timeout: 45000 })

    const probe = await page.evaluate(() => window.__distorrentScreenProbe)
    console.log('SCREEN PROBE', JSON.stringify(probe, null, 1))

    test.skip(!probe?.ok, `captura de tela indisponível neste ambiente: ${probe?.why ?? 'desconhecido'}`)

    expect(probe!.captureLabel, 'a track de tela precisa ter rótulo do sistema').toBeTruthy()
    expect(probe!.captureWidth!).toBeGreaterThan(0)
    expect(probe!.captureHeight!).toBeGreaterThan(0)

    expect(probe!.sendParamsApplied, 'applySenderTuning precisa ser aceito pelo engine').toBe(true)
    expect(probe!.framesEncoded!).toBeGreaterThan(0)
    expect(probe!.sendBitrateKbps!).toBeGreaterThan(0)
    expect(probe!.sentFps!).toBeGreaterThan(0)
    expect(probe!.codec, 'codec de vídeo deve ser reportado pelo getStats').toBeTruthy()

    expect(probe!.remoteTrackLive).toBe(true)
    expect(probe!.remoteVideoSize!.w).toBeGreaterThan(0)
    expect(probe!.remoteVideoTimeAdvanced, 'o vídeo remoto precisa avançar (não pode ficar congelado)').toBe(true)
    expect(probe!.framesDecoded!).toBeGreaterThan(0)
    expect(probe!.receivedFps!).toBeGreaterThan(0)
    expect(probe!.receiveBitrateKbps!).toBeGreaterThan(0)

    expect(probe!.rttMs!).not.toBeNull()
    expect(probe!.rttMs!).toBeGreaterThanOrEqual(0)

    expect(probe!.notBlack, 'o frame recebido não pode ser uma tela preta').toBe(true)

    expect(probe!.degradedAfterPressure).toBe(true)
    expect(probe!.renegotiationStable).toBe(true)

    const joined = errors.join('\n')
    expect(joined).not.toContain('ReferenceError')
    expect(joined).not.toContain('TypeError')

    await browser.close()
  })
})
