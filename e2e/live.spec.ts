import { test, expect, type Page } from '@playwright/test';

// BUG2: amigo/grupo deve aparecer AO VIVO (sem restart) via BroadcastChannel.
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

test('amizade aceita + DM aparecem ao vivo, sem restart', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  const fpB = await fpOf(b);

  // A pede amizade a B
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder('Digite o fingerprint do seu amigo').fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();

  // B vê o pedido AO VIVO (sem reload)
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });

  // B aceita
  await b.getByRole('button', { name: 'Aceitar' }).first().click();

  // A vê o amigo AO VIVO na lista Todos (sem reload)
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.getByText(fpB.slice(0, 12)).first()).toBeVisible({ timeout: 15000 });

  // A DM aparece AO VIVO na lista de conversas (sem reload)
  await expect(a.locator('.nav-row', { hasText: 'Bob' }).first()).toBeVisible({ timeout: 15000 });
  await ctx.close();
});

test('grupo criado aparece ao vivo na outra aba, sem restart', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  const fpB = await fpOf(b);

  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder('Digite o fingerprint do seu amigo').fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  await b.getByRole('button', { name: 'Aceitar' }).first().click();
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.getByText(fpB.slice(0, 12)).first()).toBeVisible({ timeout: 15000 });

  // A cria grupo com B
  await a.getByTitle('Criar grupo (igual Discord)').first().click();
  await a.getByPlaceholder('Ex: Squad').fill('Squad');
  await a.locator('label', { hasText: 'Bob' }).locator('input[type="checkbox"]').check();
  await a.getByRole('button', { name: 'Criar grupo (1)' }).click();

  // B vê o grupo AO VIVO (sem reload)
  await expect(b.locator('.nav-row', { hasText: 'Squad' }).first()).toBeVisible({ timeout: 15000 });
  await ctx.close();
});
