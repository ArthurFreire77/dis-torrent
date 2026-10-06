import { test, expect, type Page } from '@playwright/test';
import { createServerViaWizard } from './helpers/server';

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

  // passo 'create' agora é o assistente v6 (helper robusto: label, não placeholder)
  await page.getByText('Criar meu próprio', { exact: false }).click();
  const wizard = page.getByRole('dialog', { name: 'Criar servidor' });
  await expect(wizard).toBeVisible({ timeout: 10000 });

  // etapa 1: identidade (nome é obrigatório; descrição opcional)
  await wizard.getByLabel('Nome do servidor').fill('Guilda do Teste');
  await wizard.getByLabel('Descrição do servidor').fill('servidor do teste v6');
  await wizard.getByRole('button', { name: 'Continuar' }).click();

  // etapa 2: canais — o preset já vem com canal válido, só seguir
  await expect(wizard.getByRole('group', { name: /Passo 2/ })).toBeVisible({ timeout: 5000 });
  await wizard.getByRole('button', { name: 'Continuar' }).click();

  // etapa 3: cargos — presets valem, só seguir
  await expect(wizard.getByRole('group', { name: /Passo 3/ })).toBeVisible({ timeout: 5000 });
  await wizard.getByRole('button', { name: 'Continuar' }).click();

  // etapa 4: regras (opcional) + criar
  await expect(wizard.getByRole('group', { name: /Passo 4/ })).toBeVisible({ timeout: 5000 });
  await wizard.getByLabel('Regras do servidor').fill('sem flood');
  await wizard.getByRole('button', { name: 'Criar servidor' }).click();

  // tela final: confirmação + link de convite pronto para copiar
  await expect(wizard.getByRole('heading', { name: 'Servidor criado' })).toBeVisible({ timeout: 15000 });
  await expect(wizard.getByText(/invite/i)).toBeVisible();

  // concluir fecha e nada quebra
  await wizard.getByRole('button', { name: 'Concluir' }).click();
  await expect(wizard).toBeHidden({ timeout: 10000 });

  // o servidor criado aparece na rail e abre com canais
  await page.locator('.rail-btn[title="Guilda do Teste"]').click();
  await expect(page.locator('.chan-row').first()).toBeVisible({ timeout: 10000 });
});

test('helper compartilhado também cria servidor utilizável', async ({ page }) => {
  // trava o contrato do helper que o resto da suite usa: se ele quebrar,
  // este teste aponta o problema em vez de 20 testes falharem juntos.
  await createAccount(page, 'Carol');
  await createServerViaWizard(page, 'ServidorDoHelper');
  await page.locator('.rail-btn[title="ServidorDoHelper"]').click();
  await expect(page.locator('.chan-row').first()).toBeVisible({ timeout: 10000 });
});

test('wizard cancelável sem criar nada (X fecha e nada persiste)', async ({ page }) => {
  await createAccount(page, 'Bob');
  await page.getByTitle('Adicionar um servidor').click();
  await page.getByText('Criar meu próprio', { exact: false }).click();
  const wizard = page.getByRole('dialog', { name: 'Criar servidor' });
  await expect(wizard).toBeVisible({ timeout: 10000 });

  // preenche o nome para provar que cancelar DESCARTA dados preenchidos
  await wizard.getByLabel('Nome do servidor').fill('Servidor Fantasma');

  await wizard.getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(wizard).toBeHidden({ timeout: 10000 });

  // nada persistiu: o nome nunca aparece na rail
  await expect(page.locator('.rail-btn[title="Servidor Fantasma"]')).toHaveCount(0);
});
