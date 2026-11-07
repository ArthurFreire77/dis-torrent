import { test, expect, type Page } from '@playwright/test';

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

async function befriend(a: Page, b: Page) {
  const fpB = await fpOf(b);
  const fpA = await fpOf(a);
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  // O placeholder mudou quando a entrada passou a aceitar chave pública também.
  await a.getByPlaceholder(/Fingerprint \(12\) ou chave p/i).fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  await b.getByRole('button', { name: 'Aceitar' }).first().click();
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.locator('.friend-row', { hasText: fpB }).first()).toBeVisible({ timeout: 15000 });
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
        const config = args[0] && typeof args[0] === 'object'
          ? { ...args[0], iceServers: [] }
          : { iceServers: [] };
        return Reflect.construct(target, [config, ...args.slice(1)]);
      },
    });
  })));
}

test('badge de fase: Chamando… no A antes do aceitar; Conectado após conectar', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await useLocalHostIce([a, b]);
  const errsA: string[] = [];
  collectCrashSignals(a, errsA);
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriend(a, b);

  await a.locator('.friend-row', { hasText: 'Bob' }).first().getByTitle('Conversar').click();
  await expect(a.getByPlaceholder(/Conversar com/)).toBeVisible({ timeout: 10000 });
  await a.getByTitle(/Iniciar chamada de voz/).click();

  await expect(a.getByText(/^(Discando|Chamando)…$/)).toBeVisible({ timeout: 15000 });

  await expect(b.getByRole('button', { name: 'Aceitar' })).toBeVisible({ timeout: 20000 });
  await b.getByRole('button', { name: 'Aceitar' }).click();
  await Promise.all([
    expect(a.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 }),
    expect(b.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 }),
  ]);

  await a.getByRole('button', { name: 'Sair' }).first().click();
  await expect(a.getByText(/^Conectado • /)).toBeHidden({ timeout: 10000 });

  const joined = errsA.join('\n');
  expect(joined).not.toContain('ReferenceError');
  expect(joined).not.toContain("Can't find variable");
});

test('recusada mostra aviso honesto (máquina: remote-reject)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await useLocalHostIce([a, b]);
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriend(a, b);

  await a.locator('.friend-row', { hasText: 'Bob' }).first().getByTitle('Conversar').click();
  await a.getByTitle(/Iniciar chamada de voz/).click();
  await expect(b.getByRole('button', { name: 'Recusar' })).toBeVisible({ timeout: 20000 });

  await b.getByRole('button', { name: 'Recusar' }).click();
  await expect(a.getByText('chamada recusada')).toBeVisible({ timeout: 15000 });
  await expect(a.getByText(/^(Discando|Chamando)…$/)).toBeHidden({ timeout: 10000 });
});
