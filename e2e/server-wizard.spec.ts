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
  await wizard.getByRole('button', { name: 'Continuar' }).click();

  await expect(wizard.getByRole('group', { name: /Passo 2/ })).toBeVisible({ timeout: 5000 });
  await wizard.getByRole('button', { name: 'Continuar' }).click();

  await expect(wizard.getByRole('group', { name: /Passo 3/ })).toBeVisible({ timeout: 5000 });
  await wizard.getByRole('button', { name: 'Continuar' }).click();

  await expect(wizard.getByRole('group', { name: /Passo 4/ })).toBeVisible({ timeout: 5000 });
  await wizard.getByLabel('Regras do servidor').fill('sem flood');
  await wizard.getByRole('button', { name: 'Criar servidor' }).click();

  await expect(wizard.getByText('Pronto. O convite está abaixo.').first()).toBeVisible({ timeout: 15000 });
  await expect(wizard.getByText(/invite/i)).toBeVisible();

  await wizard.getByRole('button', { name: 'Concluir' }).click();
  await expect(wizard).toBeHidden({ timeout: 10000 });

  await page.locator('.rail-btn[title="Guilda do Teste"]').click();
  await expect(page.locator('.chan-row').first()).toBeVisible({ timeout: 10000 });
});

test('helper compartilhado também cria servidor utilizável', async ({ page }) => {
  await createAccount(page, 'Carol');
  await createServerViaWizard(page, 'ServidorDoHelper');
  await page.locator('.rail-btn[title="ServidorDoHelper"]').click();
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
