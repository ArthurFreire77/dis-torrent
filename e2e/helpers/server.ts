import { expect, type Page } from '@playwright/test'

const WIZARD = '#csw-title' as const

export async function createServerViaWizard(page: Page, name: string, openIt = true): Promise<void> {
  await page.getByTitle('Adicionar um servidor').click()
  const hub = page.getByRole('dialog', { name: 'Servidores' })
  await expect(hub).toBeVisible({ timeout: 10000 })
  await hub.getByRole('button', { name: 'Criar servidor', exact: true }).click()

  const wizard = page.locator(WIZARD).locator('xpath=ancestor::*[@role="dialog"]')
  await expect(wizard).toBeVisible({ timeout: 10000 })

  await wizard.getByLabel('Nome do servidor').fill(name)

  const continua = () => wizard.getByRole('button', { name: 'Continuar' })

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

  await expect(wizard.getByText('Pronto. O convite está abaixo.').first()).toBeVisible({ timeout: 20000 })
  await wizard.getByRole('button', { name: 'Concluir' }).click()
  await expect(wizard).toBeHidden({ timeout: 10000 })

  if (openIt) {
    // `.first()`: o rail pode ter o mesmo servidor em mais de um estado
    // (ativo + lista). Sem isto o Playwright recusa o clique ambíguo.
    await page.locator(`.rail-btn[title="${name}"]`).first().click()
    await expect(page.locator('.chan-row').first()).toBeVisible({ timeout: 10000 })
  }
}

export async function accountWithConversation(page: Page, name: string, server = 'ServidorTeste'): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 })
  await page.getByPlaceholder('Seu nome').fill(name)
  await page.getByRole('button', { name: 'Criar conta' }).click()
  await expect(page).toHaveURL(/\/d\/distorrent/, { timeout: 15000 })
  await createServerViaWizard(page, server)
}