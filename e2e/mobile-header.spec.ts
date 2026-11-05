import { test, expect, type Page } from '@playwright/test';
import { createServerViaWizard } from './helpers/server';

async function boot(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/d/distorrent');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill('Movel');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/distorrent/, { timeout: 15000 });
  await createServerViaWizard(page, 'Servidor Cabecalho');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/m');
  await expect(page.getByRole('button', { name: 'Servidores', exact: true })).toBeVisible({ timeout: 15000 });
}

async function openConversation(page: Page) {
  await page.getByRole('button', { name: 'Servidores', exact: true }).click();
  await page.getByRole('button', { name: /Servidor Cabecalho/ }).click();
  // O canal do mobile é um botão rotulado ("Abrir canal de texto"), não
  // `.chan-row` (essa classe só existe no desktop).
  const canal = page.getByRole('button', { name: /Abrir canal de texto/ }).first();
  await expect(canal).toBeVisible({ timeout: 15000 });
  await canal.click();
  await expect(page.getByRole('textbox', { name: 'Mensagem' })).toBeVisible({ timeout: 10000 });
}

test.describe('cabeçalho do mobile sem poluição', () => {
  test('barra superior não tem mais busca nem download', async ({ page }) => {
    await boot(page);
    await openConversation(page);

    await expect(page.getByLabel('Buscar nesta conversa')).toHaveCount(0);
    await expect(page.getByLabel('Downloads')).toHaveCount(0);
  });

  test('menu ⋯ expõe buscar e downloads', async ({ page }) => {
    await boot(page);
    await openConversation(page);

    await page.getByLabel('Mais opções').click();

    await expect(page.getByText('Buscar mensagens')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Downloads/)).toBeVisible();

    await page.getByText('Buscar mensagens').click();
    const sheet = page.getByRole('dialog', { name: 'Buscar mensagens' });
    await expect(sheet).toBeVisible({ timeout: 5000 });
    await expect(sheet.getByRole('textbox', { name: 'Buscar mensagens' })).toBeVisible();
  });

  test('barra superior não transborda em tela estreita (360px)', async ({ page }) => {
    await boot(page);
    await openConversation(page);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(300);

    const overflow = await page.evaluate(() => {
      const bar = document.querySelector('.m-topbar, header');
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      return [...bar.querySelectorAll('button')].some(
        (b) => b.getBoundingClientRect().right > window.innerWidth + 1 || b.getBoundingClientRect().left < -1,
      ) ? { scrollW: r.width, inner: window.innerWidth } : null;
    });
    expect(overflow).toBeNull();
  });
});
