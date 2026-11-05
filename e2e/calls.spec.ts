import { test, expect, type Page } from '@playwright/test';

async function createAccount(page: Page, name: string) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
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

function assertNoWebRTCrash(allErrors: string[]) {
  const joined = allErrors.join('\n');
  expect(joined).not.toContain("Can't find variable");
  expect(joined).not.toContain('RTCPeerConnection is not defined');
  expect(joined).not.toContain('ReferenceError');
}

test('chamada de voz mantém conversa visível no painel lateral sem crash (ou mensagem honesta sem WebRTC)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  const errsA: string[] = [];
  const errsB: string[] = [];
  collectCrashSignals(a, errsA);
  collectCrashSignals(b, errsB);

  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  const { fpA, fpB } = await befriendLive(a, b);

  await a.locator('.nav-row', { hasText: 'Bob' }).first().click();

  const hasRTC = await a.evaluate(() => typeof RTCPeerConnection !== 'undefined');
  const hasMedia = await a.evaluate(
    () => typeof navigator !== 'undefined' && !!(navigator as unknown as { mediaDevices?: unknown }).mediaDevices,
  );

  if (!hasRTC || !hasMedia) {
    const honest = a.getByTitle(/indisponíveis/).first();
    await expect(honest).toBeVisible({ timeout: 10000 });
    await expect(honest).toBeDisabled();
    assertNoWebRTCrash([...errsA, ...errsB]);
    await ctx.close();
    return;
  }

  const voiceBtn = a.getByTitle('Iniciar chamada de voz');
  await expect(voiceBtn).toBeVisible({ timeout: 15000 });
  await expect(voiceBtn).toBeEnabled();
  await voiceBtn.click();

  const panel = a.getByTestId('call-panel');
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(a.getByLabel('Mensagem')).toBeVisible();
  const localTile = panel.locator(`[data-call-participant="${fpA}"]`);
  await expect(localTile).toBeVisible();
  const normalWidth = await panel.evaluate(el => el.getBoundingClientRect().width);
  await a.getByTestId('call-panel-smaller').click();
  await expect.poll(() => panel.evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(normalWidth);
  await a.getByTestId('call-panel-larger').click();
  await expect.poll(() => panel.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(normalWidth);
  await localTile.getByRole('button', { name: /Fixar/ }).click();
  await expect(localTile.getByRole('button', { name: /Ampliar participante fixado/ })).toBeVisible();
  await localTile.getByRole('button', { name: /Ampliar participante fixado/ }).click();
  await expect(localTile).toBeVisible();

  await expect(a.getByText(/1 participante/)).toBeVisible({ timeout: 15000 });

  await expect(b.getByText(/está ligando/)).toBeVisible({ timeout: 15000 });
  void fpB;

  assertNoWebRTCrash([...errsA, ...errsB]);

  await ctx.close();
});

test('sem WebRTC: clique mostra diagnóstico detalhado honesto (sem crash)', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try {
      (window as unknown as Record<string, unknown>).RTCPeerConnection = undefined;
    } catch {}
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

  const rtcType = await a.evaluate(() => typeof RTCPeerConnection);
  expect(rtcType).toBe('undefined');

  const HONEST = 'chamadas de voz/vídeo indisponíveis neste aparelho';

  const voiceHonest = a.getByTitle(/indisponíveis/).first();
  await expect(voiceHonest).toBeVisible({ timeout: 10000 });
  const titleAttr = await voiceHonest.getAttribute('title').catch(() => '');
  expect(String(titleAttr ?? '')).toContain(HONEST);
  expect(String(titleAttr ?? '').toLowerCase()).toContain('atualize o webview');

  await voiceHonest.click({ force: true }).catch(() => {});
  await a.waitForTimeout(500);
  assertNoWebRTCrash([...errsA, ...errsB]);
  const bodyText = await a.locator('body').innerText().catch(() => '');
  expect(bodyText).toContain(HONEST);

  await ctx.close();
});
