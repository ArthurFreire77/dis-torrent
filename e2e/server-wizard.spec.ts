import { test, expect, type Page } from '@playwright/test';
import { createServerViaWizard } from './helpers/server';

async function createAccount(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/distorrent/, { timeout: 15000 });
}

test('wizard completo: 4 passos criam servidor com convite', async ({ page }) => {
  await createAccount(page, 'Alice');

  await page.getByTitle('Adicionar um servidor').click();
  await expect(page.getByRole('dialog', { name: 'Servidores' })).toBeVisible({ timeout: 10000 });

  await page.getByRole('dialog', { name: 'Servidores' }).getByRole('button', { name: 'Criar servidor', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: 'Criar servidor' });
  await expect(wizard).toBeVisible({ timeout: 10000 });

  await wizard.getByLabel('Nome do servidor').fill('Guilda do Teste');
  await wizard.getByLabel('Descrição do servidor').fill('servidor do teste v6');

  // O wizard ganhou o passo de bots (virou 5 passos). Em vez de contar passos
  // (o teste quebrava a cada passo novo), avança até aparecer "Criar servidor".
  const criar = wizard.getByRole('button', { name: 'Criar servidor', exact: true });
  for (let passo = 0; passo < 8; passo++) {
    if (await criar.isVisible().catch(() => false)) break;
    const continua = wizard.getByRole('button', { name: 'Continuar' });
    if (!(await continua.isVisible().catch(() => false))) break;
    await continua.click();
    await page.waitForTimeout(150);
  }

  const regras = wizard.getByLabel('Regras do servidor');
  if (await regras.isVisible().catch(() => false)) await regras.fill('sem flood');
  await criar.click();

  await expect(wizard.getByText('Pronto. O convite está abaixo.').first()).toBeVisible({ timeout: 15000 });
  await expect(wizard.getByText(/invite/i)).toBeVisible();

  await wizard.getByRole('button', { name: 'Concluir' }).click();
  await expect(wizard).toBeHidden({ timeout: 10000 });

  await page.locator('.rail-btn[title="Guilda do Teste"]').first().click();
  await expect(page.locator('.chan-row').first()).toBeVisible({ timeout: 10000 });
});

test('helper compartilhado também cria servidor utilizável', async ({ page }) => {
  await createAccount(page, 'Carol');
  await createServerViaWizard(page, 'ServidorDoHelper');
  await expect(page.locator('.chan-row').first()).toBeVisible({ timeout: 10000 });
});

test('wizard cancelável sem criar nada (X fecha e nada persiste)', async ({ page }) => {
  await createAccount(page, 'Bob');
  await page.getByTitle('Adicionar um servidor').click();
  await page.getByRole('dialog', { name: 'Servidores' }).getByRole('button', { name: 'Criar servidor', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: 'Criar servidor' });
  await expect(wizard).toBeVisible({ timeout: 10000 });

  await wizard.getByLabel('Nome do servidor').fill('Servidor Fantasma');

  await wizard.getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(wizard).toBeHidden({ timeout: 10000 });

  await expect(page.locator('.rail-btn[title="Servidor Fantasma"]')).toHaveCount(0);
});
