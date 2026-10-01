import { test, expect, type Page } from '@playwright/test';

// v6 — bots conectados à web: criar bot, abrir o painel (prefixo, comando
// REST, escopo, webhook), salvar config e regenerar token. Token mascarado
// para não-dono é garantia do backend (community_state_payload) — aqui
// cobrimos o fluxo do DONO no browser.

async function createAccount(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/forge/, { timeout: 15000 });
}

async function createServerViaWizard(page: Page, name: string): Promise<void> {
  await page.getByTitle('Adicionar um servidor').click();
  await page.getByText('Criar meu próprio', { exact: false }).click();
  const wizard = page.getByRole('dialog', { name: 'Criar servidor' });
  await expect(wizard).toBeVisible({ timeout: 10000 });
  await wizard.getByPlaceholder('ex.: cantinho dos amigos').fill(name);
  await wizard.getByRole('button', { name: 'Continuar' }).click();
  await wizard.getByRole('button', { name: 'Continuar' }).click();
  await wizard.getByRole('button', { name: 'Continuar' }).click();
  await wizard.getByPlaceholder('ex.: sem flood, sem spam, respeite todo mundo').fill('regras');
  await wizard.getByRole('button', { name: 'Criar servidor' }).click();
  await expect(wizard.getByText('Convidar', { exact: false })).toBeVisible({ timeout: 15000 });
  await wizard.getByRole('button', { name: 'Concluir' }).click();
  await expect(wizard).toBeHidden({ timeout: 10000 });
}

async function openServerSettingsBots(page: Page): Promise<void> {
  // menu do servidor (cabeçalho da sidebar) → item "Bots" abre as configurações já na aba
  await page.locator('.server-head').click();
  await page.locator('.dd-item', { hasText: 'Bots' }).click();
}

test('dono adiciona bot, configura comando REST e salva config', async ({ page }) => {
  await createAccount(page, 'Alice');
  await createServerViaWizard(page, 'ServidorBots');

  await openServerSettingsBots(page);

  // cria o bot
  await page.getByPlaceholder('MeuBot').fill('ClimeBot');
  await page.getByRole('button', { name: 'Adicionar bot' }).click();
  await expect(page.getByText('ClimeBot').first()).toBeVisible({ timeout: 15000 });

  // abre o painel v6
  await page.getByTitle('Comandos web, token e escopos').first().click();
  const panel = page.getByRole('dialog', { name: 'Configurar ClimeBot' });
  await expect(panel).toBeVisible({ timeout: 10000 });

  // prefixo + um comando GET
  await panel.getByLabel('prefixo do bot').fill('!')
  await panel.getByLabel('nome do comando 1').fill('clima')
  await panel.getByLabel('url do comando 1').fill('https://api.exemplo.com/clima/{{query}}')
  await panel.getByLabel('responsePath do comando 1').fill('data.temp')
  await panel.getByLabel('template de resposta do comando 1').fill('{{value}}°C agora')

  // salva — config vai para o BotRow (cap 16KB no Rust) e re-renderiza a lista
  await panel.getByRole('button', { name: 'Salvar' }).click();
  await expect(panel).toBeHidden({ timeout: 10000 });
});

test('regenerar token troca o token visível (dono)', async ({ page }) => {
  await createAccount(page, 'Dona');
  await createServerViaWizard(page, 'ServidorToken');
  await openServerSettingsBots(page);

  await page.getByPlaceholder('MeuBot').fill('Bot');
  await page.getByRole('button', { name: 'Adicionar bot' }).click();
  // bot criado aparece na lista com o token visível (dono vê token real)
  await expect(page.getByText(/bot_/).first()).toBeVisible({ timeout: 15000 });

  // abre o painel e regenera — aviso honesto: "token antigo foi invalidado"
  await page.getByTitle('Comandos web, token e escopos').first().click();
  const panel = page.getByRole('dialog', { name: 'Configurar Bot' });
  await expect(panel).toBeVisible({ timeout: 10000 });
  const before = await panel.getByText(/bot_/).first().textContent().catch(() => '')
  await panel.getByLabel('Gerar novo token').click();
  await expect(panel.getByText('token antigo foi invalidado')).toBeVisible({ timeout: 10000 });
  const after = await panel.getByText(/bot_/).first().textContent().catch(() => '')
  // token realmente mudou no painel
  expect(after).not.toBe(before)
});
