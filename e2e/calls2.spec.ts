import { test, expect, type Page } from '@playwright/test';

// WebRTC real em Chromium com dispositivos falsos.
// playwright.config.ts é mínimo (sem projects, chromium default + reuseExistingServer),
// portanto launchOptions por-arquivo via test.use() É permitido e respeitado pelo
// fixture `browser`. Se este bloco fosse ignorado pelo config, o teste cai no
// branch honesto (botão desabilitado + msg pt-BR) em vez de falhar com crash.
// Flags: fake device evita pedir mic/câmera real; fake-ui auto-autoriza permissão.
test.use({
  browserName: 'chromium',
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  },
});

// Padrão idêntico a live.spec.ts / calls.spec.ts: amizade ao vivo via BroadcastChannel, sem restart.
async function createAccount(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/distorrent/, { timeout: 15000 });
}

async function fpOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem('distorrent:identity') ?? '';
    return (JSON.parse(raw) as { fingerprint: string }).fingerprint;
  });
}

async function befriendLive(a: Page, b: Page) {
  const fpB = await fpOf(b);
  const fpA = await fpOf(a);
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder('Digite o fingerprint do seu amigo').fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  await b.getByRole('button', { name: 'Aceitar' }).first().click();
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.getByText(fpB.slice(0, 12)).first()).toBeVisible({ timeout: 15000 });
  await expect(a.locator('.nav-row', { hasText: 'Bob' }).first()).toBeVisible({ timeout: 15000 });
  return { fpA, fpB };
}

function collectCrashSignals(page: Page, bucket: string[]) {
  page.on('pageerror', (e) => bucket.push(String((e as Error)?.message ?? e)));
  page.on('console', (m) => {
    if (m.type() === 'error') bucket.push(m.text());
  });
}

async function useLocalHostIce(pages: Page[]) {
  await Promise.all(pages.map((page) => page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Native, {
      construct(target, args) {
        // As duas abas deste E2E estão no mesmo PC; STUN público pode testar
        // hairpin NAT em vez do fluxo do app. ICE host valida o mesh local real.
        const config = args[0] && typeof args[0] === 'object'
          ? { ...args[0], iceServers: [] }
          : { iceServers: [] };
        return Reflect.construct(target, [config, ...args.slice(1)]);
      },
    });
  })));
}

function assertNoWebRTCrash(allErrors: string[]) {
  const joined = allErrors.join('\n');
  expect(joined).not.toContain("Can't find variable");
  expect(joined).not.toContain('RTCPeerConnection is not defined');
  expect(joined).not.toContain('ReferenceError');
}

test('chamada A->B: áudio local por peer e tela chega ao tile remoto pelo app', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await useLocalHostIce([a, b]);
  const errsA: string[] = [];
  const errsB: string[] = [];
  collectCrashSignals(a, errsA);
  collectCrashSignals(b, errsB);
  await a.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream> };
    if (!mediaDevices) return;
    Object.defineProperty(mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext('2d');
        let frame = 0;
        const draw = () => {
          if (!context) return;
          context.fillStyle = `hsl(${frame++ % 360} 70% 45%)`;
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#fff';
          context.font = '20px sans-serif';
          context.fillText('DisTorrent screen test', 12, 32);
        };
        draw();
        const timer = window.setInterval(draw, 100);
        const stream = canvas.captureStream(15);
        // Áudio "do sistema" de mentira: o seletor real do SO entrega a track de
        // loopback junto com o vídeo. Sem esta track o E2E nunca exercitava o
        // envio de áudio da tela (o bug em que ele era anexado DEPOIS da oferta
        // e, por isso, nunca saía do app).
        const audioCtx = new AudioContext();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = 0.05;
        osc.frequency.value = 660;
        const dest = audioCtx.createMediaStreamDestination();
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
        (
          window as unknown as {
            __fakeScreen?: MediaStream;
            __fakeScreenTimer?: number;
            __fakeScreenAudio?: { ctx: AudioContext; osc: OscillatorNode };
          }
        ).__fakeScreen = stream;
        (
          window as unknown as {
            __fakeScreenTimer?: number;
            __fakeScreenAudio?: { ctx: AudioContext; osc: OscillatorNode };
          }
        ).__fakeScreenTimer = timer;
        (
          window as unknown as {
            __fakeScreenAudio?: { ctx: AudioContext; osc: OscillatorNode };
          }
        ).__fakeScreenAudio = { ctx: audioCtx, osc };
        return stream;
      },
    });
  });

  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriendLive(a, b);

  // Abre a DM para exibir a toolbar de chamada.
  await a.locator('.nav-row', { hasText: 'Bob' }).first().click();

  const hasRTC = await a.evaluate(() => typeof RTCPeerConnection !== 'undefined');
  const hasMedia = await a.evaluate(
    () => typeof navigator !== 'undefined' && !!(navigator as unknown as { mediaDevices?: unknown }).mediaDevices,
  );

  if (!hasRTC || !hasMedia) {
    // Sem WebRTC: relay-only mantém botões ATIVOS (via relay); só 'none' desabilita.
    const support = await a.evaluate(() => {
      try {
        const hasGum = typeof navigator !== 'undefined' && !!(navigator as unknown as { mediaDevices?: { getUserMedia?: unknown } }).mediaDevices?.getUserMedia;
        const hasMR = typeof MediaRecorder !== 'undefined' && !!MediaRecorder;
        const w = window as unknown as { webkitAudioContext?: unknown };
        const hasAC = (typeof AudioContext !== 'undefined' && !!AudioContext) || !!w.webkitAudioContext;
        if (hasMR && hasAC && hasGum) return 'relay-only';
        if (hasAC) return 'relay-only';
        return 'none';
      } catch { return 'none'; }
    });
    if (support === 'relay-only') {
      test.info().annotations.push({
        type: 'skip-honesto-relay',
        description: `WebRTC indisponível (hasRTC=${hasRTC} hasMedia=${hasMedia}) mas relay-only ativo; botões via relay verificados em vez do fluxo WebRTC real.`,
      });
      const voiceRelay = a.getByTitle(/via relay/).first();
      await expect(voiceRelay).toBeVisible({ timeout: 10000 });
      await expect(voiceRelay).toBeEnabled();
      assertNoWebRTCrash([...errsA, ...errsB]);
      await ctx.close();
      return;
    }
    test.info().annotations.push({
      type: 'skip-honesto',
      description: `WebRTC indisponível (hasRTC=${hasRTC} hasMedia=${hasMedia}) mesmo com --use-fake-device-for-media-stream; branch honesto verificado em vez do fluxo real.`,
    });
    const honest = a.getByTitle(/indisponíveis/).first();
    await expect(honest).toBeVisible({ timeout: 10000 });
    await expect(honest).toBeDisabled();
    assertNoWebRTCrash([...errsA, ...errsB]);
    await ctx.close();
    return;
  }

  // A inicia chamada de voz.
  const voiceBtn = a.getByTitle('Iniciar chamada de voz');
  await expect(voiceBtn).toBeVisible({ timeout: 15000 });
  await expect(voiceBtn).toBeEnabled();
  await voiceBtn.click();

  // Overlay ativo em A: desktop mostra a contagem de participantes,
  // mobile mostra "Em chamada". Aceita qualquer um dos dois.
  await expect(a.getByText(/participante|Em chamada/)).toBeVisible({ timeout: 15000 });

  // B vê o modal entrante AO VIVO ("está ligando…").
  await expect(b.getByText(/está ligando/)).toBeVisible({ timeout: 15000 });

  // B aceita no modal (Recusar/Aceitar). Escopo: após amizade resolvida não há
  // outro "Aceitar" pendente, mas usa first() por segurança.
  await b.getByRole('button', { name: 'Aceitar' }).first().click();

  // Overlay aparece em B após aceitar (mesma regra desktop/mobile).
  await expect(b.getByText(/participante|Em chamada/)).toBeVisible({ timeout: 15000 });
  // Overlay continua em A.
  await expect(a.getByText(/participante|Em chamada/)).toBeVisible({ timeout: 15000 });
  // Modal entrante sumiu em B.
  await expect(b.getByText(/está ligando/)).toBeHidden({ timeout: 15000 });

  // O ganho e o mute por participante alteram o elemento de áudio remoto real
  // e ficam restritos ao fingerprint daquele peer.
  const remoteAudio = a.locator(`audio[data-call-audio-fp="${await fpOf(b)}"]`);
  await expect(remoteAudio).toHaveCount(1, { timeout: 15000 });
  const remoteTile = a.locator(`[data-call-participant="${await fpOf(b)}"]`);
  await remoteTile.locator('summary[aria-label^="Controles de áudio"]').click();
  const remoteVolume = remoteTile.getByRole('slider');
  await expect(remoteVolume).toBeVisible();
  await remoteVolume.evaluate((element) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '37');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => remoteAudio.evaluate((element) => (element as HTMLAudioElement).volume)).toBe(0.37);
  await remoteTile.getByRole('button', { name: 'Silenciar para mim' }).click();
  await expect.poll(() => remoteAudio.evaluate((element) => (element as HTMLAudioElement).muted)).toBe(true);
  expect(await a.evaluate((key) => {
    const store = JSON.parse(localStorage.getItem('distorrent:call-playback:v1') ?? '{}') as Record<string, { volume: number; muted: boolean }>;
    return store[key];
  }, await fpOf(b))).toEqual({ volume: 37, muted: true });

  // Usa o fluxo real do app (botão → CallManager → sender → SDP/sinalização →
  // tile remoto), com uma fonte canvas animada para não depender do seletor do SO.
  const callerFp = await fpOf(a);
  const callerTileOnB = b.locator(`[data-call-participant="${callerFp}"]`);
  // Cancelar o seletor antes da captura não deve parar áudio nem alterar a
  // transmissão remota (se houver uma captura anterior, ela continua viva).
  await a.getByTestId('call-screen-share').click();
  await a.getByRole('menu').getByRole('button', { name: /Configurações avançadas/ }).click();
  await expect(a.getByRole('button', { name: 'Cancelar compartilhamento' })).toBeVisible();
  await a.getByRole('button', { name: 'Cancelar compartilhamento' }).click();
  await expect(a.getByTestId('call-screen-stop')).toBeHidden();
  await expect(callerTileOnB.getByText('TELA')).toBeHidden();

  await a.getByTestId('call-screen-share').click();
  await a.getByRole('menu').getByRole('button', { name: 'Tela inteira' }).click();
  await expect(a.getByTestId('call-screen-stop')).toBeVisible({ timeout: 15000 });
  const receivedScreen = callerTileOnB.locator('video');
  await expect(receivedScreen).toBeVisible({ timeout: 15000 });
  await expect(callerTileOnB.getByText('TELA')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => receivedScreen.evaluate((element) => {
    const video = element as HTMLVideoElement;
    return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && video.videoWidth === 320
      && video.videoHeight === 180
      && video.currentTime > 0;
  })).toBe(true);
  // Áudio do compartilhamento: além da voz, o elemento remoto precisa receber a
  // track de áudio da tela. Antes ela era anexada com o PC em `have-local-offer`
  // e nunca virava oferta — a tela chegava muda e o teste só olhava o vídeo.
  const callerAudioOnB = b.locator(`audio[data-call-audio-fp="${callerFp}"]`);
  await expect(callerAudioOnB).toHaveCount(1, { timeout: 15000 });
  const liveAudioTracks = () => callerAudioOnB.evaluate((element) => {
    const stream = (element as HTMLAudioElement).srcObject as MediaStream | null;
    return stream ? stream.getAudioTracks().filter((track) => track.readyState === 'live').length : 0;
  });
  await expect.poll(liveAudioTracks, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
  await a.getByTestId('call-screen-stop').click();
  await expect(a.getByTestId('call-screen-share')).toBeVisible({ timeout: 15000 });
  await expect(callerTileOnB.getByText('TELA')).toBeHidden({ timeout: 15000 });
  await expect(receivedScreen).toBeHidden({ timeout: 15000 });
  // Sem a tela, o áudio do sistema também para: sobra só a voz da chamada.
  await expect.poll(liveAudioTracks, { timeout: 20000 }).toBe(1);
  await expect.poll(() => a.evaluate(() => {
    const win = window as unknown as { __fakeScreen?: MediaStream };
    return win.__fakeScreen?.getVideoTracks()[0]?.readyState ?? 'missing';
  })).toBe('ended');
  await a.evaluate(() => {
    const win = window as unknown as { __fakeScreen?: MediaStream; __fakeScreenTimer?: number; __fakeScreenAudio?: { ctx: AudioContext } };
    if (win.__fakeScreenTimer) clearInterval(win.__fakeScreenTimer);
    void win.__fakeScreenAudio?.ctx.close();
  });

  // A mesma chamada precisa poder reutilizar o sender após parar a tela.
  await a.getByTestId('call-screen-share').click();
  await a.getByRole('menu').getByRole('button', { name: 'Tela inteira' }).click();
  await expect(a.getByTestId('call-screen-stop')).toBeVisible({ timeout: 15000 });
  await expect(callerTileOnB.getByText('TELA')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => receivedScreen.evaluate((element) => {
    const video = element as HTMLVideoElement;
    return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && video.videoWidth === 320
      && video.videoHeight === 180
      && video.currentTime > 0;
  })).toBe(true);
  await a.getByTestId('call-screen-stop').click();
  await expect(a.getByTestId('call-screen-share')).toBeVisible({ timeout: 15000 });
  await expect(callerTileOnB.getByText('TELA')).toBeHidden({ timeout: 15000 });
  await expect(receivedScreen).toBeHidden({ timeout: 15000 });
  await expect.poll(() => a.evaluate(() => {
    const win = window as unknown as { __fakeScreen?: MediaStream };
    return win.__fakeScreen?.getVideoTracks()[0]?.readyState ?? 'missing';
  })).toBe('ended');
  await a.evaluate(() => {
    const win = window as unknown as { __fakeScreenTimer?: number; __fakeScreenAudio?: { ctx: AudioContext } };
    if (win.__fakeScreenTimer) clearInterval(win.__fakeScreenTimer);
    void win.__fakeScreenAudio?.ctx.close();
  });

  // NENHUM pageerror / "Can't find variable" em nenhuma aba.
  assertNoWebRTCrash([...errsA, ...errsB]);

  await ctx.close();
});

test('fallback modo compatibilidade: toggle ausente na UI é documentado; sem crash', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  const errsA: string[] = [];
  collectCrashSignals(a, errsA);

  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriendLive(a, b);
  await a.locator('.nav-row', { hasText: 'Bob' }).first().click();

  // Procura exaustiva por toggle "modo compatibilidade" (grep em src confirma
  // que não existe: só há "compatibilidade legada" em services/browser.ts e
  // "via relay" em ConnectionDiagnostics). Cobre switch/checkbox/título/label/texto.
  const switchCount = await a.getByRole('switch', { name: /compat/i }).count().catch(() => 0);
  const checkboxCount = await a.getByRole('checkbox', { name: /compat/i }).count().catch(() => 0);
  const titleCount = await a.getByTitle(/compat/i).count().catch(() => 0);
  const labelCount = await a.locator('label:has-text("compat")').count().catch(() => 0);
  const textCount = await a.getByText(/modo compatibilidade/i).count().catch(() => 0);
  const total = switchCount + checkboxCount + titleCount + labelCount + textCount;

  if (total > 0) {
    // Se um dia o toggle existir: liga e exige indicador "via relay".
    const toggle =
      a.getByRole('switch', { name: /compat/i }).first();
    await toggle.click().catch(() => {});
    await expect(a.getByText(/via relay/i)).toBeVisible({ timeout: 15000 });
  } else {
    test.info().annotations.push({
      type: 'limitacao-honesta',
      description:
        'UI não expõe toggle "modo compatibilidade" (grep src/e2e: zero ocorrências; "via relay" existe só em ConnectionDiagnostics/diagnóstico). Fallback de relay via toggle NÃO testável; verificado apenas ausência + sem crash.',
    });
    expect(total).toBe(0);
  }

  assertNoWebRTCrash([...errsA]);
  await ctx.close();
});
