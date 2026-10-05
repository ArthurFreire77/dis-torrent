import { test, expect, type Page } from '@playwright/test';

// BUG1: arquivo = mensagem com botão Baixar; envio funciona; limites validados.
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

async function befriend(a: Page, b: Page) {
  const fpB = await fpOf(b);
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder('Digite o fingerprint do seu amigo').fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  await b.getByRole('button', { name: 'Aceitar' }).first().click();
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.getByText(fpB.slice(0, 12)).first()).toBeVisible({ timeout: 15000 });
}

test('arquivo enviado vira mensagem com Baixar nas duas abas; download funciona', async ({ browser }) => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriend(a, b);

  // A abre a DM com Bob
  await a.locator('.friend-row', { hasText: 'Bob' }).first().getByTitle('Conversar').click();
  await expect(a.getByPlaceholder(/Conversar com/)).toBeVisible({ timeout: 10000 });

  // A anexa um arquivo pequeno (input real — era o que faltava no mobile)
  await a.locator('input[type="file"]').setInputFiles({
    name: 'oi.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ola do swarm! '.repeat(200)),
  });

  // cartão com Baixar aparece para A…
  await expect(a.getByRole('button', { name: /Baixar/ }).first()).toBeVisible({ timeout: 15000 });
  // …e AO VIVO para B ao abrir a DM (sem reload)
  await b.locator('.nav-row', { hasText: 'Alice' }).first().click();
  await expect(b.getByRole('button', { name: /Baixar/ }).first()).toBeVisible({ timeout: 15000 });

  // B clica Baixar → busca chunks do swarm e salva (download via blob/âncora)
  const dlPromise = b.waitForEvent('download', { timeout: 30000 });
  await b.getByRole('button', { name: /Baixar/ }).first().click();
  const dl = await dlPromise;
  expect(dl.suggestedFilename()).toBe('oi.txt');
  await ctx.close();
});

test('limites de arquivo são barrados com erro visível', async ({ page }) => {
  await createAccount(page, 'Carol');

  // Acima do teto (o default e' 2 GB, configuravel por VITE_FORGE_MAX_FILE_MB).
  // Usa 8 GB para ser barrado independente do teto configurado.
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('forge:bus', { detail: {
      type: 'file_announce', file_id: 'evil-big', name: 'big.bin',
      size: 8 * 1024 * 1024 * 1024, chunks: 32768, hash: 'a'.repeat(32), from_fp: 'abcdef123456',
    } }))
  );
  await expect(page.getByText(/arquivo muito grande \(limite/)).toBeVisible({ timeout: 10000 });

  // chunks acima do limite rejeitado
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('forge:bus', { detail: {
      type: 'file_announce', file_id: 'evil-chunks', name: 'x.bin',
      size: 1024, chunks: 40000, hash: 'b'.repeat(32), from_fp: 'abcdef123456',
    } }))
  );
  await expect(page.getByText(/chunks acima do limite/)).toBeVisible({ timeout: 10000 });
});
