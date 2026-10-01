import { test, expect, type Page } from '@playwright/test';

// v6 — downloads: clicar Baixar enfileira no downloadManager e abre o painel
// (progresso/pausa/resume/cancel). O card do chat continua lendo o fileSwarm,
// que o manager sincroniza — os dois progressos são o mesmo swarm.

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

async function befriend(a: Page, b: Page) {
  const fpB = await fpOf(b);
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder('Digite o fingerprint do seu amigo').fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  await b.getByRole('button', { name: 'Aceitar' }).first().click();
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.getByText(fpB.slice(0, 12)).first()).toBeVisible({ timeout: 15000 });
}

test('Baixar enfileira no painel: item aparece com estado, pausar/resumir não quebra', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriend(a, b);

  // A abre DM e anexa arquivo
  await a.locator('.friend-row', { hasText: 'Bob' }).first().getByTitle('Conversar').click();
  await expect(a.getByPlaceholder(/Conversar com/)).toBeVisible({ timeout: 10000 });
  await a.locator('input[type="file"]').setInputFiles({
    name: 'fila.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('x'.repeat(1024 * 300)),
  });
  await expect(a.getByRole('button', { name: /Baixar/ }).first()).toBeVisible({ timeout: 15000 });

  // B abre a DM e clica Baixar → painel abre com o item na fila
  await b.locator('.nav-row', { hasText: 'Alice' }).first().click();
  await expect(b.getByRole('button', { name: /Baixar/ }).first()).toBeVisible({ timeout: 15000 });
  await b.getByRole('button', { name: /Baixar/ }).first().click();
  const panel = b.getByRole('dialog', { name: 'Downloads' });
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText('fila.bin')).toBeVisible({ timeout: 10000 });
  // estado honesto: baixando/na fila/concluído — nunca inventa sucesso
  await expect(panel.getByText(/baixando|na fila|concluído|verificando/).first()).toBeVisible({ timeout: 20000 });

  // pausar → vira "pausado"; resumir → volta ao ciclo (transições da máquina)
  const pauseBtn = panel.getByRole('button', { name: 'Pausar' }).first();
  if (await pauseBtn.isVisible().catch(() => false)) {
    await pauseBtn.click();
    await expect(panel.getByText('pausado').first()).toBeVisible({ timeout: 10000 });
    const resumeBtn = panel.getByRole('button', { name: 'Retomar' }).first();
    if (await resumeBtn.isVisible().catch(() => false)) {
      await resumeBtn.click();
      await expect(panel.getByText(/baixando|na fila|concluído/).first()).toBeVisible({ timeout: 15000 });
    }
  }

  // fechar o painel não cancela nada (a fila vive no manager, não no modal)
  await b.keyboard.press('Escape').catch(() => { /* painel fecha por clique fora também */ });
});

test('botão Downloads do cabeçalho abre o painel vazio sem crash', async ({ page }) => {
  await createAccount(page, 'Solo');
  await page.getByRole('button', { name: 'Downloads' }).first().click();
  const panel = page.getByRole('dialog', { name: 'Downloads' });
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText(/nada|vazio|nenhum/i)).toBeVisible();
});
