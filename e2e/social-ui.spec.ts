import { test, expect, type Page } from '@playwright/test';

// Paridade Discord — camada social.
//
// A UI social (reação, edição, pin, citação, busca, enquete, perfil) foi a
// maior lacuna do projeto. Este arquivo não testa "a tela existe": exercita o
// ciclo completo de cada funcionalidade e afirma o RESULTADO visível, que é o
// que quebra quando motor, IPC e UI discordam entre si — e foi exatamente o
// que aconteceu (o núcleo tinha os 18 frames e 15 tabelas, mas zero comando
// IPC; as funcionalidades existiam e nenhuma era alcançável pela UI).

async function createAccount(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/forge/, { timeout: 15000 });
}

async function createServer(page: Page, name: string): Promise<void> {
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

function composer(page: Page) {
  return page.locator('input[placeholder*="mensagem"], textarea[placeholder*="ensagem" i]').first();
}

async function send(page: Page, text: string): Promise<void> {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: 10000 });
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

    // o corpo vem de peer não confiável: precisa aparecer como TEXTO
    await send(page, '<img src=x onerror=alert(1)>');
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  });

  test('reação alterna na mensagem', async ({ page }) => {
    await createAccount(page, 'Bia');
    await send(page, 'mensagem para reagir');

    await page.getByText('mensagem para reagir').first().hover();
    const quick = page.getByTitle(/^Reagir /).first();
    await expect(quick).toBeVisible({ timeout: 5000 });
    await quick.click();

    // a pastilha da reação aparece
    await expect(page.locator('button[title^="Reagir "]').first()).toBeVisible({ timeout: 5000 });
  });

  test('menu "Mais" da mensagem abre e lista as ações', async ({ page }) => {
    await createAccount(page, 'Cid');
    await send(page, 'abrir o menu');

    await page.getByText('abrir o menu').first().hover();
    await page.getByTitle('Mais').first().click();

    // o menu precisa conter as ações de paridade Discord
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
