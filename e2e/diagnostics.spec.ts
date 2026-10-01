import { test, expect, type Page } from '@playwright/test';

async function createAccountDesktop(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/forge/, { timeout: 15000 });
}

async function createAccountMobile(page: Page, name: string) {
  await page.goto('/m');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  // mobile fica em /m mesmo após criar conta (sem redirect)
  // bottom-nav "Você" tem texto; avatar do header é só aria-label — filtra por texto
  await expect(page.locator('button').filter({ hasText: 'Você' }).first()).toBeVisible({ timeout: 15000 });
}

test('desktop: diagnóstico mostra versão+fp e copia relatório', async ({ page }) => {
  await createAccountDesktop(page, 'DiagAlice');

  // Configurações (engrenagem no rodapé) → Diagnóstico de conexão
  await page.getByTitle('Configurações').click();
  await expect(page.getByText('versão', { exact: false }).first()).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: /Diagnóstico de conexão/ }).click();

  const panel = page.getByTestId('diag-panel');
  await expect(panel).toBeVisible({ timeout: 10000 });

  const version = (await page.getByTestId('diag-version').innerText()).trim();
  expect(version.length).toBeGreaterThan(0);
  const fp = (await page.getByTestId('diag-fp').innerText()).trim();
  expect(fp.length).toBeGreaterThan(5);

  await expect(page.getByTestId('diag-state')).toBeVisible();
  await expect(page.getByTestId('diag-peers')).toBeVisible();
  await expect(page.getByTestId('diag-relay')).toBeVisible();

  const report = (await page.getByTestId('diag-report-text').innerText()).trim();
  expect(report).toContain('versão:');
  expect(report).toContain('fingerprint:');
  expect(report).toContain(version);
  // fp completo aparece no relatório (não só o curto da lista)
  expect(report).toContain(fp.slice(0, 6));

  // clipboard mock honesto (headless pode negar permissão real)
  await page.evaluate(() => {
    const w = window as unknown as { __copied?: string };
    w.__copied = '';
    const nav = navigator as unknown as { clipboard: { writeText: (s: string) => Promise<void> } };
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (s: string) => { w.__copied = s; return Promise.resolve(); } },
        configurable: true,
      });
    } catch {
      nav.clipboard = { writeText: (s: string) => { w.__copied = s; return Promise.resolve(); } };
    }
  });
  await page.getByRole('button', { name: 'Copiar relatório' }).click();
  await expect(page.getByText('Relatório copiado!')).toBeVisible({ timeout: 10000 });
  const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '');
  expect(copied).toContain('versão:');
  expect(copied).toContain('fingerprint:');
  expect(copied).toContain(version);
});

test('mobile: diagnóstico acessível pelo menu Você e copia relatório', async ({ page }) => {
  await createAccountMobile(page, 'DiagBob');

  await page.locator('button').filter({ hasText: 'Você' }).first().click();
  await page.getByRole('button', { name: /Diagnóstico de conexão/ }).click();

  const panel = page.getByTestId('diag-panel');
  await expect(panel).toBeVisible({ timeout: 10000 });

  const version = (await page.getByTestId('diag-version').innerText()).trim();
  expect(version.length).toBeGreaterThan(0);
  const fp = (await page.getByTestId('diag-fp').innerText()).trim();
  expect(fp.length).toBeGreaterThan(5);

  const report = (await page.getByTestId('diag-report-text').innerText()).trim();
  expect(report).toContain('versão:');
  expect(report).toContain('fingerprint:');

  await page.evaluate(() => {
    const w = window as unknown as { __copied?: string };
    w.__copied = '';
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (s: string) => { w.__copied = s; return Promise.resolve(); } },
        configurable: true,
      });
    } catch { /* ignore */ }
  });
  await page.getByRole('button', { name: 'Copiar relatório' }).click();
  await expect(page.getByText('Relatório copiado!')).toBeVisible({ timeout: 10000 });
  const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '');
  expect(copied).toContain(version.slice(0, 3));
});
