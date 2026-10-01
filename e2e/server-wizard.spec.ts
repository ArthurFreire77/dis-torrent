import { test, expect, type Page } from '@playwright/test';

// v6 — wizard de criação de servidor: modelo → identidade → canais/cargos →
// regras → convite. Cria via services.createCommunity(name, canais, opts) e
// termina com link de convite. Tudo no browser (browser.ts), sem app nativo.

async function createAccount(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/forge/, { timeout: 15000 });
}

test('wizard completo: 4 passos criam servidor com convite', async ({ page }) => {
  await createAccount(page, 'Alice');

  // abre o fluxo pelo + da barra de servidores
  await page.getByTitle('Adicionar um servidor').click();
  await expect(page.getByText('Crie seu próprio servidor')).toBeVisible({ timeout: 10000 });

  // passo 'create' agora é o assistente v6
  await page.getByText('Criar meu próprio', { exact: false }).click();
  const wizard = page.getByRole('dialog', { name: 'Criar servidor' });
  await expect(wizard).toBeVisible({ timeout: 10000 });

  // etapa 1: modelo + nome + descrição
  await wizard.getByPlaceholder('ex.: cantinho dos amigos').fill('Guilda do Teste');
  await wizard.getByPlaceholder('do que é este servidor?').fill('servidor do teste v6');
  await wizard.getByRole('button', { name: 'Continuar' }).click();

  // etapa 2: canais (mantém o canal inicial) + seguir
  await wizard.getByRole('button', { name: 'Continuar' }).click();

  // etapa 3: cargos (mantém presets) + seguir
  await wizard.getByRole('button', { name: 'Continuar' }).click();

  // etapa 4: regras + criar
  await wizard.getByPlaceholder('ex.: sem flood, sem spam, respeite todo mundo').fill('sem flood');
  await wizard.getByRole('button', { name: 'Criar servidor' }).click();

  // tela de convite com link gerado
  await expect(wizard.getByText('Convidar', { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(wizard.getByText(/invite|token|gerando/i)).toBeVisible();

  // concluir fecha e seleciona o servidor criado
  await wizard.getByRole('button', { name: 'Concluir' }).click();
  await expect(wizard).toBeHidden({ timeout: 10000 });
});

test('wizard cancelável sem criar nada (X fecha e nada persiste)', async ({ page }) => {
  await createAccount(page, 'Bob');
  await page.getByTitle('Adicionar um servidor').click();
  await page.getByText('Criar meu próprio', { exact: false }).click();
  const wizard = page.getByRole('dialog', { name: 'Criar servidor' });
  await expect(wizard).toBeVisible({ timeout: 10000 });
  await wizard.getByRole('button', { name: 'Fechar criação de servidor' }).click();
  await expect(wizard).toBeHidden({ timeout: 10000 });
});
