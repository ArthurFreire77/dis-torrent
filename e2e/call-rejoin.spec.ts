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
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder(/Fingerprint \(12\) ou chave p/i).fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  await b.getByRole('button', { name: 'Aceitar' }).first().click();
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.locator('.friend-row', { hasText: fpB.slice(0, 12) }).first()).toBeVisible({ timeout: 15000 });
}

function collectCrashSignals(page: Page, bucket: string[]) {
  page.on('pageerror', (e) => bucket.push(String((e as Error)?.message ?? e)));
  page.on('console', (m) => {
    if (m.type() === 'error') bucket.push(m.text());
  });
}

async function useLocalHostIce(pages: Page[]) {
  await Promise.all(pages.map((p) => p.addInitScript(() => {
    const Native = window.RTCPeerConnection
    window.RTCPeerConnection = new Proxy(Native, {
      construct(target, args) {
        const options = args[0] && typeof args[0] === 'object' ? { ...args[0], iceServers: [] } : { iceServers: [] }
        return Reflect.construct(target, [options, ...args.slice(1)])
      },
    })
  })))
}

async function dial(a: Page, name: string) {
  const inDm = await a.getByPlaceholder(/Conversar com/).isVisible().catch(() => false)
  if (!inDm) {
    await a.getByRole('button', { name: 'Amigos' }).first().click();
    const todos = a.getByRole('button', { name: 'Todos' });
    await expect(todos).toBeVisible({ timeout: 8000 });
    await todos.click();
    const row = a.locator('.friend-row', { hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.getByTitle('Conversar').click();
    await expect(a.getByPlaceholder(/Conversar com/)).toBeVisible({ timeout: 10000 });
  }
  await a.getByTitle(/Iniciar chamada de voz/).click();
}

async function assertNoCrash(errs: string[]) {
  const joined = errs.join('\n');
  expect(joined).not.toContain('ReferenceError');
  expect(joined).not.toContain("Can't find variable");
  expect(joined).not.toContain('RTCPeerConnection is not defined');
}

test('chamar → conectar → sair → chamar DE NOVO conecta (mesma direção)', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await useLocalHostIce([a, b])
  const errs: string[] = [];
  collectCrashSignals(a, errs);
  collectCrashSignals(b, errs);
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriend(a, b);

  await dial(a, 'Bob');
  await expect(a.getByText(/^(Discando|Chamando)…/)).toBeVisible({ timeout: 15000 });
  await expect(b.getByRole('button', { name: 'Aceitar' })).toBeVisible({ timeout: 20000 });
  await b.getByRole('button', { name: 'Aceitar' }).click();
  await expect(a.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });
  await expect(b.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });

  await a.getByTestId('call-leave').click();
  await expect(a.getByText(/^Conectado • /)).toBeHidden({ timeout: 10000 });
  await expect(b.getByText(/^Conectado • /)).toBeHidden({ timeout: 15000 });

  await dial(a, 'Bob');
  await expect(a.getByText(/^(Discando|Chamando)…/)).toBeVisible({ timeout: 15000 });
  await expect(b.getByRole('button', { name: 'Aceitar' })).toBeVisible({ timeout: 20000 });
  await b.getByRole('button', { name: 'Aceitar' }).click();
  await Promise.all([
    expect(a.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 }),
    expect(b.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 }),
  ]);

  assertNoCrash(errs);
  await ctx.close();
});

test('quem ATENDEu consegue ligar de volta depois de sair (direção invertida)', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await useLocalHostIce([a, b])
  const errs: string[] = [];
  collectCrashSignals(a, errs);
  collectCrashSignals(b, errs);
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriend(a, b);

  await dial(a, 'Bob');
  await expect(b.getByRole('button', { name: 'Aceitar' })).toBeVisible({ timeout: 20000 });
  await b.getByRole('button', { name: 'Aceitar' }).click();
  await expect(b.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });

  await b.getByTestId('call-leave').click();
  await expect(b.getByText(/^Conectado • /)).toBeHidden({ timeout: 10000 });
  await expect(a.getByText(/^Conectado • /)).toBeHidden({ timeout: 15000 });

  await dial(b, 'Alice');
  await expect(b.getByText(/^(Discando|Chamando)…/)).toBeVisible({ timeout: 15000 });
  await expect(a.getByRole('button', { name: 'Aceitar' })).toBeVisible({ timeout: 20000 });
  await a.getByRole('button', { name: 'Aceitar' }).click();
  await expect(a.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });
  await expect(b.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });

  assertNoCrash(errs);
  await ctx.close();
});
