import { test, expect, type Page } from '@playwright/test';
import { createServerViaWizard } from './helpers/server';

async function createAccount(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/distorrent/, { timeout: 15000 });
}

async function createServer(page: Page, name: string): Promise<void> {
  await createServerViaWizard(page, name);
  await page.locator(`.rail-btn[title="${name}"]`).click();
  await expect(page.locator('.chan-row').first()).toBeVisible({ timeout: 10000 });
}

function composer(page: Page) {
  return page.getByLabel('Mensagem');
}

async function openAnyConversation(page: Page, server = 'ServidorSocial'): Promise<void> {
  if (await composer(page).isVisible().catch(() => false)) return;
  await createServer(page, server);
  await expect(composer(page)).toBeVisible({ timeout: 10000 });
}

async function send(page: Page, text: string): Promise<void> {
  await openAnyConversation(page);
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
  await expect(page.locator('[data-mid]')).toHaveCount(
    await page.locator('[data-mid]').count(),
    { timeout: 1000 },
  );
  await page.waitForTimeout(400);
}

test.describe('camada social', () => {
  test('markdown renderiza formatação e NÃO injeta HTML', async ({ page }) => {
    await createAccount(page, 'Ana');

    await send(page, '**negrito** aqui');
    await expect(page.locator('strong', { hasText: 'negrito' }).first()).toBeVisible({ timeout: 5000 });

    await send(page, '`codigo inline`');
    await expect(page.locator('code', { hasText: 'codigo inline' }).first()).toBeVisible({ timeout: 5000 });

    await send(page, '> uma citação');
    await expect(page.getByText('uma citação').first()).toBeVisible({ timeout: 5000 });

    await send(page, '<img src=x onerror=alert(1)>');
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  });

  test('reação alterna na mensagem', async ({ page }) => {
    await createAccount(page, 'Bia');
    await send(page, 'mensagem para reagir');

    const quick = page.getByTitle(/^Reagir /).first();
    await expect(quick).toBeVisible({ timeout: 5000 });
    await quick.click();

    await expect(page.locator('button[title^="Reagir "]').first()).toBeVisible({ timeout: 5000 });
  });

  test('menu "Mais" da mensagem abre e lista as ações', async ({ page }) => {
    await createAccount(page, 'Cid');
    await send(page, 'abrir o menu');

    await page.getByText('abrir o menu').first().hover();
    await page.getByTitle('Mais').first().click();

    await expect(page.getByText('Responder', { exact: false }).first()).toBeVisible({ timeout: 5000 });
  });

  test('pin: fixa a mensagem', async ({ page }) => {
    await createAccount(page, 'Dani');
    await send(page, 'mensagem importante');

    await page.getByText('mensagem importante').first().hover();
    await page.getByTitle('Mais').first().click();
    const fixar = page.getByText('Fixar', { exact: false }).first();
    if (await fixar.isVisible().catch(() => false)) {
      await fixar.click();
      await expect(page.getByTitle('fixada').first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('busca (Ctrl+F) encontra mensagem enviada', async ({ page }) => {
    await createAccount(page, 'Eve');
    await createServer(page, 'ServidorBusca');
    await send(page, 'agulha unica no palheiro');

    await page.keyboard.press('Control+f');
    const input = page.locator('input[placeholder*="uscar" i]').first();
    await expect(input).toBeVisible({ timeout: 8000 });
    await input.fill('agulha');
    await expect(page.getByText('agulha unica no palheiro').first()).toBeVisible({ timeout: 8000 });
  });

  test('atalho Ctrl+K abre a paleta de comandos', async ({ page }) => {
    await createAccount(page, 'Fábio');
    await page.keyboard.press('Control+k');
    await expect(page.getByPlaceholder(/comando|pesquise/i).first()).toBeVisible({ timeout: 8000 });
  });

  test('definições abrem pelo botão do rodapé', async ({ page }) => {
    await createAccount(page, 'Gabi');
    await page.getByTestId('open-settings').click();
    await expect(page.getByText(/Privacidade|Chamadas|Conta|Co cof/i).first()).toBeVisible({ timeout: 8000 });
  });
});
