import { test, expect, type Page } from '@playwright/test';
import { createServerViaWizard } from './helpers/server';

async function createAccount(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/distorrent/, { timeout: 15000 });
}

async function openServerSettingsBots(page: Page): Promise<void> {
  await page.locator('.server-head').click();
  await page.locator('.dd-item', { hasText: 'Bots' }).click();
}

async function createBot(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Criar bot', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: 'Criar bot' });
  await expect(modal).toBeVisible({ timeout: 5000 });
  await modal.getByLabel('Nome do bot').fill(name);
  await modal.getByRole('button', { name: 'Criar bot', exact: true }).click();
  await expect(modal).toBeHidden({ timeout: 10000 });
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 15000 });
}

test('dono adiciona bot, configura comando REST e salva config', async ({ page }) => {
  await createAccount(page, 'Alice');
  await createServerViaWizard(page, 'ServidorBots');

  await openServerSettingsBots(page);
  await createBot(page, 'ClimeBot');

  await page.getByRole('button', { name: 'Configurar ClimeBot' }).click();
  const panel = page.getByRole('region', { name: 'Configurar ClimeBot' });
  await expect(panel).toBeVisible({ timeout: 10000 });

  await panel.getByRole('tab', { name: 'Comandos' }).click();
  await panel.getByRole('button', { name: /Adicionar comando/ }).click();
  await panel.getByLabel('Nome do comando 1').fill('clima');
  await panel.getByLabel('Tipo do comando 1').selectOption('http');
  await panel.getByLabel('URL do comando 1').fill('https://api.exemplo.com/clima/{{query}}');
  await panel.getByLabel('Caminho da resposta do comando 1').fill('data.temp');
  await panel.getByLabel('Template do comando 1').fill('{{value}}°C agora');

  await panel.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(panel.getByText('Configuração salva e validada pelo core.')).toBeVisible({ timeout: 10000 });
});

test('bot recém-criado não aparece como "config inválida"', async ({ page }) => {
  await createAccount(page, 'Nova');
  await createServerViaWizard(page, 'ServidorNovo');
  await openServerSettingsBots(page);
  await createBot(page, 'NovoBot');

  // Config vazia é o padrão do core; marcar isso como inválido acusava todo
  // bot novo e mandava o dono caçar um problema que não existe.
  await expect(page.getByText('config inválida')).toHaveCount(0);
  await expect(page.getByText('0 comando(s)')).toBeVisible();
});

test('regenerar token troca o token visível (dono)', async ({ page }) => {
  await createAccount(page, 'Dona');
  await createServerViaWizard(page, 'ServidorToken');

  await openServerSettingsBots(page);
  await createBot(page, 'Bot');

  await page.getByRole('button', { name: 'Configurar Bot' }).click();
  const panel = page.getByRole('region', { name: 'Configurar Bot' });
  await expect(panel).toBeVisible({ timeout: 10000 });
  const tokenBox = panel.locator('[data-bot-token]').first();
  const before = await tokenBox.textContent();

  await panel.getByRole('button', { name: 'Gerar novo token' }).click();
  const confirm = page.getByRole('dialog', { name: 'Gerar novo token?' });
  await expect(confirm).toBeVisible({ timeout: 5000 });
  await confirm.getByRole('button', { name: 'Gerar e invalidar o antigo' }).click();
  await expect(confirm).toBeHidden({ timeout: 10000 });

  await expect(tokenBox).not.toHaveText(before ?? '', { timeout: 15000 });
});

test('painel mostra as ações novas com os argumentos e salva comando de conteúdo', async ({ page }) => {
  await createAccount(page, 'Autora');
  await createServerViaWizard(page, 'ServidorAcoes');
  await openServerSettingsBots(page);
  await createBot(page, 'ConteudoBot');

  await page.getByRole('button', { name: 'Configurar ConteudoBot' }).click();
  const panel = page.getByRole('region', { name: 'Configurar ConteudoBot' });
  await expect(panel).toBeVisible({ timeout: 10000 });

  await panel.getByRole('tab', { name: 'Comandos' }).click();
  await panel.getByRole('button', { name: /Adicionar comando/ }).click();
  await panel.getByLabel('Nome do comando 1').fill('fixar');
  await panel.getByLabel('Tipo do comando 1').selectOption('admin');
  await panel.getByLabel('Ação administrativa do comando 1').selectOption('pin');

  // A UI não pode oferecer a ação sem dizer o que ela espera.
  await expect(panel.getByText('<id-da-mensagem>')).toBeVisible();
  // O core só aceita a ação se o bot tiver o bit; o painel avisa antes.
  await expect(panel.getByText(/permissão da ação precisa estar concedida/i)).toBeVisible();

  await panel.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(panel.getByText('Configuração salva e validada pelo core.')).toBeVisible({ timeout: 10000 });
});
