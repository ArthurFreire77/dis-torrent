import { test, expect, type Page } from '@playwright/test';

// Cofre & Backup (5.4) no modo browser (rota mobile /m):
// - painel mostra aviso "app nativo" (export/import exigem o nativo)
// - modo pânico limpa chaves forge:* do localStorage
// - 2 mensagens numa DM aparecem (cobre a janela de mensagens da UI)

async function createAccount(page: Page, name: string) {
  await page.goto('/m');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  // bottom-nav "Você" (header também tem aria-label Você — nav é o último)
  await expect(page.getByRole('button', { name: 'Você' }).last()).toBeVisible({ timeout: 15000 });
}

async function fpOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem('forge:identity') ?? '';
    return (JSON.parse(raw) as { fingerprint: string }).fingerprint;
  });
}

async function befriendMobile(a: Page, b: Page) {
  const fpB = await fpOf(b);
  await a.getByRole('button', { name: 'Amigos' }).click();
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder('Ex.: a1b2c3d4e5f6').fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();
  await b.getByRole('button', { name: 'Amigos' }).click();
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  await b.getByLabel('Aceitar').click();
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.getByText(fpB.slice(0, 12)).first()).toBeVisible({ timeout: 15000 });
}

test('cofre mostra aviso de app nativo no modo browser', async ({ page }) => {
  await createAccount(page, 'Cofre');
  await page.getByRole('button', { name: 'Você' }).last().click();
  await expect(page.getByText('COFRE & BACKUP')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('funciona apenas no')).toBeVisible();
});

// Gate aberto (contrato stormvault + vaultWipe no browserServices): reativado.
test('modo pânico do browser limpa chaves forge: e mantém as demais', async ({ page }) => {
  await createAccount(page, 'Panico');
  await page.evaluate(() => {
    localStorage.setItem('forge:teste:a', '1');
    localStorage.setItem('forge:teste:b', '2');
    localStorage.setItem('outra-chave', 'fica');
  });
  await page.getByRole('button', { name: 'Você' }).last().click();
  await page.getByPlaceholder('digite APAGAR para confirmar').fill('APAGAR');
  await page.getByRole('button', { name: 'Apagar tudo' }).click();
  await expect(page.getByText('Dados locais apagados')).toBeVisible({ timeout: 10000 });
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => k.startsWith('forge:'))).toEqual([]);
  expect(keys).toContain('outra-chave');
});

test('duas mensagens numa DM aparecem nas duas pontas', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await createAccount(a, 'AliceV');
  await createAccount(b, 'BobV');
  await befriendMobile(a, b);

  // A abre a DM e envia 2 mensagens
  await a.getByRole('button', { name: 'Amigos' }).click();
  await a.getByRole('button', { name: 'Todos' }).click();
  const fpB = await fpOf(b);
  const rowA = a.locator('.friend-row, .m-row', { hasText: fpB.slice(0, 12) }).first();
  await rowA.getByLabel('Conversar').click();
  await expect(a.getByPlaceholder(/Conversar com/)).toBeVisible({ timeout: 10000 });
  const stamp = Date.now().toString(36);
  await a.getByPlaceholder(/Conversar com/).fill(`cofre-msg-1 ${stamp}`);
  await a.getByPlaceholder(/Conversar com/).press('Enter');
  await expect(a.getByText(`cofre-msg-1 ${stamp}`)).toBeVisible({ timeout: 15000 });
  // anti-duplo-envio da UI (300ms) — espera antes da 2ª mensagem
  await a.waitForTimeout(500);
  await a.getByPlaceholder(/Conversar com/).fill(`cofre-msg-2 ${stamp}`);
  await a.getByPlaceholder(/Conversar com/).press('Enter');
  await expect(a.getByText(`cofre-msg-2 ${stamp}`)).toBeVisible({ timeout: 15000 });

  // B abre a DM e recebe ao vivo
  await b.getByRole('button', { name: 'Amigos' }).click();
  await b.getByRole('button', { name: 'Todos' }).click();
  const fpA = await fpOf(a);
  const rowB = b.locator('.friend-row, .m-row', { hasText: fpA.slice(0, 12) }).first();
  await rowB.getByLabel('Conversar').click();
  await expect(b.getByPlaceholder(/Conversar com/)).toBeVisible({ timeout: 10000 });
  await expect(b.getByText(`cofre-msg-1 ${stamp}`)).toBeVisible({ timeout: 15000 });
  await expect(b.getByText(`cofre-msg-2 ${stamp}`)).toBeVisible({ timeout: 15000 });
  await ctx.close();
});
