import { expect, type Page } from '@playwright/test'

/**
 * Criação de servidor pelo wizard, do jeito que o app realmente se comporta.
 *
 * Os seletores usam `aria-label` e `getByRole`, nunca posição nem texto solto:
 * o wizard foi redesenhado e os testes antigos que dependiam de
 * `getByPlaceholder('ex.: cantinho dos amigos')` e de três cliques em
 * "Continuar" passaram a quebrar mesmo com o app funcionando.
 *
 * O avanço entre passos é por "Continuar", cujo estado desabilitado é
 * significativo: um botão desabilitado com o motivo escrito na tela é o
 * contrato de validação do wizard, então o helper espera ficar habilitado.
 */

// O título do diálogo MUDA a cada passo ("O que é este servidor?" → "Canais" →
// ...), então o accessible name não é constante. O `Modal` expõe um `labelId`
// fixo (`csw-title`); usá-lo é mais estável que casar com o texto do passo.
const WIZARD = '#csw-title' as const

export async function createServerViaWizard(page: Page, name: string, openIt = true): Promise<void> {
  await page.getByTitle('Adicionar um servidor').click()
  await page.getByText('Criar meu próprio', { exact: false }).click()

  // ancora no título e sobe até o dialog
  const wizard = page.locator(WIZARD).locator('xpath=ancestor::*[@role="dialog"]')
  await expect(wizard).toBeVisible({ timeout: 10000 })

  // Passo 1 — identidade
  await wizard.getByLabel('Nome do servidor').fill(name)

  const continua = () => wizard.getByRole('button', { name: 'Continuar' })

  // Avança até o botão criar ficar habilitado (cada passo pode validar).
  for (let guarda = 0; guarda < 6; guarda++) {
    const btn = continua()
    if (await btn.isEnabled().catch(() => false)) {
      await btn.click()
      await page.waitForTimeout(120)
    }
    const criar = wizard.getByRole('button', { name: 'Criar servidor', exact: true })
    if (await criar.isVisible().catch(() => false) && (await criar.isEnabled().catch(() => false))) {
      break
    }
  }

  const criar = wizard.getByRole('button', { name: 'Criar servidor', exact: true })
  await expect(criar).toBeVisible({ timeout: 10000 })
  await expect(
    criar,
    'o wizard nunca liberou "Criar servidor" — algum passo está bloqueando',
  ).toBeEnabled({ timeout: 10000 })
  await criar.click()

  // "Servidor criado" aparece como título (h2#csw-title) e como rótulo do
  // grupo do conteúdo. O título é o que indica que a criação terminou.
  await expect(wizard.locator('#csw-title')).toHaveText('Servidor criado', { timeout: 20000 })
  await wizard.getByRole('button', { name: 'Concluir' }).click()
  await expect(wizard).toBeHidden({ timeout: 10000 })

  if (openIt) {
    await page.locator(`.rail-btn[title="${name}"]`).click()
    await expect(page.locator('.chan-row').first()).toBeVisible({ timeout: 10000 })
  }
}

/** Cria a conta e já deixa um servidor aberto com o composer visível. */
export async function accountWithConversation(page: Page, name: string, server = 'ServidorTeste'): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 })
  await page.getByPlaceholder('Seu nome').fill(name)
  await page.getByRole('button', { name: 'Criar conta' }).click()
  await expect(page).toHaveURL(/\/d\/forge/, { timeout: 15000 })
  await createServerViaWizard(page, server)
}