import { test, expect, type Page } from '@playwright/test';

// BUG1 (celular): o botão + era decorativo — agora anexa de verdade no mobile.
async function createAccountMobile(page: Page, name: string) {
  await page.goto('/m');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page.getByText('AMIGOS ONLINE').first()).toBeVisible({ timeout: 15000 });
}

async function fpOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem('forge:identity') ?? '';
    return (JSON.parse(raw) as { fingerprint: string }).fingerprint;
  });
}

test('mobile: anexar arquivo envia mensagem com Baixar', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await createAccountMobile(a, 'AliceM');
  await createAccountMobile(b, 'BobM');
  const fpB = await fpOf(b);

  // A adiciona B pelo celular
  await a.getByRole('button', { name: 'Amigos' }).click();
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder('Ex.: a1b2c3d4e5f6').fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();

  // B aceita pelo celular
  await b.getByRole('button', { name: 'Amigos' }).click();
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  await b.getByRole('button', { name: 'Aceitar' }).first().click();

  // A abre a DM e anexa via botão + (antes não fazia nada)
  await a.getByRole('button', { name: 'Todos' }).click();
  await a.locator('.friend-row', { hasText: 'BobM' }).first().click();
  await a.locator('input[type="file"]').setInputFiles({
    name: 'foto.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('do celular! '.repeat(100)),
  });

  // mensagem-arquivo com botão Baixar aparece no celular
  await expect(a.getByRole('button', { name: /Baixar/ }).first()).toBeVisible({ timeout: 15000 });
  await ctx.close();
});
