import { test, expect, type Page } from '@playwright/test';
import { createServerViaWizard } from './helpers/server';

// v7 — bots conectados à web: criar bot (modal dedicado), abrir o painel
// (prefixo, comando REST, escopo, webhook), salvar config e regenerar token
// com confirmação destrutiva explícita. Token mascarado por padrão para
// não-dono é garantia do backend (community_state_payload) — aqui cobrimos o
// fluxo do DONO no browser.

async function createAccount(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/forge/, { timeout: 15000 });
}

async function openServerSettingsBots(page: Page): Promise<void> {
  // menu do servidor (cabeçalho da sidebar) → item "Bots" abre as configurações já na aba
  await page.locator('.server-head').click();
  await page.locator('.dd-item', { hasText: 'Bots' }).click();
}

/** Cria um bot pelo modal "Criar bot" e volta para a lista. */
async function createBot(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Criar bot', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: 'Criar bot' });
  await expect(modal).toBeVisible({ timeout: 5000 });
  await modal.getByLabel('Nome do bot').fill(name);
  // o confirm do rodapé tem o MESMO nome do modal — pegar o botão dentro dele
  await modal.getByRole('button', { name: 'Criar bot', exact: true }).click();
  await expect(modal).toBeHidden({ timeout: 10000 });
  // a lista passa a exibir o bot com o badge BOT
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 15000 });
}

test('dono adiciona bot, configura comando REST e salva config', async ({ page }) => {
  await createAccount(page, 'Alice');
  await createServerViaWizard(page, 'ServidorBots');

  await openServerSettingsBots(page);
  await createBot(page, 'ClimeBot');

  // abre o painel pelo ícone de configurações da linha do bot
  await page.getByRole('button', { name: 'Configurar ClimeBot' }).click();
  const panel = page.getByRole('dialog', { name: 'Configurar ClimeBot' });
  await expect(panel).toBeVisible({ timeout: 10000 });

  // prefixo + um comando GET (o painel abre em "Credenciais"; comandos na 2a aba)
  await panel.getByLabel('Prefixo dos comandos').fill('!');
  await panel.getByRole('tab', { name: 'Comandos' }).click();
  await panel.getByRole('button', { name: /Adicionar comando/ }).click();
  // A 1a linha sem nome se chama "comando 1"; depois que o nome é digitado os
  // labels passam a usar o nome — por isso o nome vai por último.
  await panel.getByLabel('URL do comando 1').fill('https://api.exemplo.com/clima/{{query}}');
  await panel.getByLabel('Caminho da resposta do comando 1').fill('data.temp');
  await panel.getByLabel('Template de resposta do comando 1').fill('{{value}}°C agora');
  await panel.getByLabel('Nome do comando 1').fill('clima');

  // salva — config vai para o BotRow (cap 16KB no Rust) e re-renderiza a lista
  await panel.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(panel).toBeHidden({ timeout: 10000 });
});

test('regenerar token troca o token visível (dono)', async ({ page }) => {
  await createAccount(page, 'Dona');
  await createServerViaWizard(page, 'ServidorToken');

  await openServerSettingsBots(page);
  await createBot(page, 'Bot');

  // abre o painel e mostra o token (mascarado por padrão)
  await page.getByRole('button', { name: 'Configurar Bot' }).click();
  const panel = page.getByRole('dialog', { name: 'Configurar Bot' });
  await expect(panel).toBeVisible({ timeout: 10000 });
  await panel.getByRole('button', { name: 'Mostrar token' }).click();
  const before = await panel.locator('.bcp-token').first().textContent();

  // regenera — confirmação destrutiva explícita
  await panel.getByRole('button', { name: 'Gerar novo token' }).click();
  const confirm = page.getByRole('dialog', { name: 'Gerar novo token?' });
  await expect(confirm).toBeVisible({ timeout: 5000 });
  await confirm.getByRole('button', { name: 'Gerar e invalidar o antigo' }).click();
  await expect(confirm).toBeHidden({ timeout: 10000 });

  // o token realmente mudou no painel
  await expect(panel.locator('.bcp-token').first()).not.toHaveText(before ?? '', {
    timeout: 15000,
  });
});
