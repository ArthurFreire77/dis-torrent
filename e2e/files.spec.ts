import { test, expect, type Page } from '@playwright/test';

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
  const fpA = await fpOf(a);
  const fpB = await fpOf(b);
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder(/Fingerprint \(12\) ou chave p/i).fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  await b.getByRole('button', { name: 'Aceitar' }).first().click();
  await b.getByRole('button', { name: 'Todos' }).click();
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.getByText(fpB.slice(0, 12)).first()).toBeVisible({ timeout: 15000 });
  return { fpA, fpB };
}

test('arquivo enviado vira mensagem com Baixar nas duas abas; download funciona', async ({ browser }) => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  const { fpA, fpB } = await befriend(a, b);

  await a.locator('.friend-row', { hasText: fpB.slice(0, 12) }).first().getByTitle('Conversar').click();
  await expect(a.getByPlaceholder(/Conversar com/)).toBeVisible({ timeout: 10000 });

  await a.locator('input[type="file"]').setInputFiles({
    name: 'oi.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ola do swarm! '.repeat(200)),
  });

  await expect(a.getByRole('button', { name: /Baixar/ }).first()).toBeVisible({ timeout: 15000 });
  await b.locator('.friend-row', { hasText: fpA.slice(0, 12) }).first().click();
  await expect(b.getByRole('button', { name: /Baixar/ }).first()).toBeVisible({ timeout: 15000 });

  const dlPromise = b.waitForEvent('download', { timeout: 30000 });
  await b.getByRole('button', { name: /Baixar/ }).first().click();
  const dl = await dlPromise;
  expect(dl.suggestedFilename()).toBe('oi.txt');
  await ctx.close();
});

test('limites de arquivo são barrados com erro visível', async ({ page }) => {
  await createAccount(page, 'Carol');

  const acimaDoTeto = 51200 * 1024 * 1024 + 1;
  await page.evaluate((size) =>
    window.dispatchEvent(new CustomEvent('distorrent:bus', { detail: {
      type: 'file_announce', file_id: 'evil-big', name: 'big.bin',
      size, chunks: 200_000, hash: 'a'.repeat(32), from_fp: 'abcdef123456',
    } })),
    acimaDoTeto,
  );
  await expect(page.getByText(/arquivo muito grande \(limite/)).toBeVisible({ timeout: 10000 });

  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('distorrent:bus', { detail: {
      type: 'file_announce', file_id: 'evil-chunks', name: 'x.bin',
      size: 1024, chunks: 300_000, hash: 'b'.repeat(32), from_fp: 'abcdef123456',
    } }))
  );
  await expect(page.getByText(/chunks acima do limite/)).toBeVisible({ timeout: 10000 });
});
