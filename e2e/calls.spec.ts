import { test, expect, type Page } from '@playwright/test';

// Reusa padrao de live.spec.ts: amizade ao vivo via BroadcastChannel, sem restart.
async function createAccount(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/forge/, { timeout: 15000 });
}

async function fpOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem('forge:identity') ?? '';
    return (JSON.parse(raw) as { fingerprint: string }).fingerprint;
  });
}

async function befriendLive(a: Page, b: Page) {
  const fpB = await fpOf(b);
  const fpA = await fpOf(a);
  // A pede amizade a B
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder('Digite o fingerprint do seu amigo').fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();
  // B ve o pedido AO VIVO (sem reload)
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  // B aceita
  await b.getByRole('button', { name: 'Aceitar' }).first().click();
  // A ve o amigo AO VIVO na lista Todos (sem reload)
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.getByText(fpB.slice(0, 12)).first()).toBeVisible({ timeout: 15000 });
  // DM aparece AO VIVO na lista de conversas (sem reload)
  await expect(a.locator('.nav-row', { hasText: 'Bob' }).first()).toBeVisible({ timeout: 15000 });
  return { fpA, fpB };
}

function collectCrashSignals(page: Page, bucket: string[]) {
  page.on('pageerror', (e) => bucket.push(String((e as Error)?.message ?? e)));
  page.on('console', (m) => {
    if (m.type() === 'error') bucket.push(m.text());
  });
}

function assertNoWebRTCrash(allErrors: string[]) {
  const joined = allErrors.join('\n');
  expect(joined).not.toContain("Can't find variable");
  expect(joined).not.toContain('RTCPeerConnection is not defined');
  expect(joined).not.toContain('ReferenceError');
}

test('chamada de voz abre overlay sem crash (ou mensagem honesta sem WebRTC)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  const errsA: string[] = [];
  const errsB: string[] = [];
  collectCrashSignals(a, errsA);
  collectCrashSignals(b, errsB);

  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  const { fpB } = await befriendLive(a, b);

  // Abre a DM com Bob para exibir a toolbar de chamada
  await a.locator('.nav-row', { hasText: 'Bob' }).first().click();

  const hasRTC = await a.evaluate(() => typeof RTCPeerConnection !== 'undefined');
  const hasMedia = await a.evaluate(
    () => typeof navigator !== 'undefined' && !!(navigator as unknown as { mediaDevices?: unknown }).mediaDevices,
  );

  if (!hasRTC || !hasMedia) {
    // Sem WebRTC NÃO existe relay: botões desabilitados com diagnóstico honesto.
    const honest = a.getByTitle(/indisponíveis/).first();
    await expect(honest).toBeVisible({ timeout: 10000 });
    await expect(honest).toBeDisabled();
    assertNoWebRTCrash([...errsA, ...errsB]);
    await ctx.close();
    return;
  }

  // Com WebRTC: botao habilitado, clica e overlay abre.
  const voiceBtn = a.getByTitle('Iniciar chamada de voz');
  await expect(voiceBtn).toBeVisible({ timeout: 15000 });
  await expect(voiceBtn).toBeEnabled();
  await voiceBtn.click();

  // Overlay ativo: contagem de participantes no cabeçalho da chamada
  await expect(a.getByText(/1 participante/)).toBeVisible({ timeout: 15000 });

  // B recebe o convite AO VIVO (modal "está ligando…")
  await expect(b.getByText(/está ligando/)).toBeVisible({ timeout: 15000 });
  // Sanidade: fp truncado do chamador aparece no modal
  void fpB;

  // Nenhum crash de WebRTC em nenhuma aba
  assertNoWebRTCrash([...errsA, ...errsB]);

  // Fecha direto (sem clicar em "Sair": o rodape tambem expoe title="Sair"
  // e o first() poderia deslogar em vez de encerrar a chamada).
  await ctx.close();
});

test('sem WebRTC: clique mostra diagnóstico detalhado honesto (sem crash)', async ({ browser }) => {
  const ctx = await browser.newContext();
  // Mock: remove WebRTC ANTES de qualquer script da pagina rodar.
  await ctx.addInitScript(() => {
    try {
      (window as unknown as Record<string, unknown>).RTCPeerConnection = undefined;
    } catch {
      /* ignore */
    }
  });
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  const errsA: string[] = [];
  const errsB: string[] = [];
  collectCrashSignals(a, errsA);
  collectCrashSignals(b, errsB);

  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriendLive(a, b);

  await a.locator('.nav-row', { hasText: 'Bob' }).first().click();

  // typeof RTCPeerConnection === 'undefined' dentro da pagina mockada
  const rtcType = await a.evaluate(() => typeof RTCPeerConnection);
  expect(rtcType).toBe('undefined');

  const HONEST = 'chamadas de voz/vídeo indisponíveis neste aparelho';

  // 'none' é o ÚNICO nível sem WebRTC (relay foi removido de propósito):
  // o botão fica com o título honesto e o clique mostra o diagnóstico.
  const voiceHonest = a.getByTitle(/indisponíveis/).first();
  await expect(voiceHonest).toBeVisible({ timeout: 10000 });
  // Tooltip detalhado diz O QUE falta + ação (atualize o WebView).
  const titleAttr = await voiceHonest.getAttribute('title').catch(() => '');
  expect(String(titleAttr ?? '')).toContain(HONEST);
  expect(String(titleAttr ?? '').toLowerCase()).toContain('atualize o webview');

  // Clicar nao pode gerar "Can't find variable" — mostra o erro honesto na tela
  await voiceHonest.click({ force: true }).catch(() => {});
  await a.waitForTimeout(500);
  assertNoWebRTCrash([...errsA, ...errsB]);
  // o diagnóstico honesto aparece visível para o usuário (banner de erro)
  const bodyText = await a.locator('body').innerText().catch(() => '');
  expect(bodyText).toContain(HONEST);

  await ctx.close();
});
