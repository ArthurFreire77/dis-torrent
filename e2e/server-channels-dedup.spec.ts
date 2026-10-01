import { test, expect, type Page } from '@playwright/test'
import { createServerViaWizard } from './helpers/server'

/**
 * Regressão: canais duplicados nas configurações do servidor.
 *
 * A causa era DUAS fontes de verdade. `communities_list` devolvia os canais do
 * servidor em `channels`, e `channel_list` devolvia os mesmos canais de novo com
 * tipo/categoria/tópico. Cada merge manual da UI filtrava duplicatas de um
 * jeito — e o do painel de bot não filtrava nada, então o mesmo canal aparecia
 * duas vezes lá.
 *
 * Estes testes contam canais por nome em cada seção. Contagem por nome e não por
 * id porque era o nome que o usuário via repetido.
 */

async function criarConta(page: Page, nome: string) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 })
  await page.getByPlaceholder('Seu nome').fill(nome)
  await page.getByRole('button', { name: 'Criar conta' }).click()
  await expect(page).toHaveURL(/\/d\/forge/, { timeout: 15000 })
}

async function abrirConfiguracoes(page: Page) {
  await page.locator('.server-head').click()
  await page.locator('.dd-item', { hasText: 'Canais' }).click()
  const dialog = page.getByRole('dialog', { name: /Configurações de/ })
  await expect(dialog).toBeVisible({ timeout: 10000 })
  return dialog
}

test('nenhum canal aparece duplicado na lista de canais', async ({ page }) => {
  await criarConta(page, 'Alice')
  await createServerViaWizard(page, 'ServidorDup', true)

  const dialog = await abrirConfiguracoes(page)
  const nomes = await dialog.evaluate((root: HTMLElement) => {
    const out: string[] = []
    for (const b of root.querySelectorAll('button[aria-label^="Editar canal"]')) {
      const m = b.getAttribute('aria-label')?.match(/Editar canal (.+)$/)
      if (m) out.push(m[1])
    }
    return out
  })

  expect(nomes.length, 'o wizard cria canais, a lista não está vazia').toBeGreaterThan(0)
  const dups = nomes.filter((n, i) => nomes.indexOf(n) !== i)
  expect(dups, `canais duplicados: ${JSON.stringify(dups)}`).toEqual([])
})

test('contador da navegação bate com a lista real de canais', async ({ page }) => {
  await criarConta(page, 'Bob')
  await createServerViaWizard(page, 'ServidorContagem', true)

  const dialog = await abrirConfiguracoes(page)
  const texto = await dialog.innerText()

  // O contador da nav é o número ao lado do rótulo "Canais".
  const m = texto.match(/Canais\s*\n?\s*(\d+)/)
  expect(m, `não achei o contador de canais em:\n${texto.slice(0, 400)}`).not.toBeNull()
  const contadorNav = Number(m![1])

  // Conta as linhas de canal de verdade no corpo.
  const linhas = await dialog.evaluate(
    (root: HTMLElement) => root.querySelectorAll('button[aria-label^="Editar canal"]').length,
  )

  expect(
    contadorNav,
    `contador diz ${contadorNav} mas há ${linhas} linhas de canal`,
  ).toBe(linhas)
})

test('criar canal não duplica os existentes', async ({ page }) => {
  await criarConta(page, 'Carla')
  await createServerViaWizard(page, 'ServidorCriar', true)

  const dialog = await abrirConfiguracoes(page)

  async function nomes() {
    return dialog.evaluate((root: HTMLElement) => {
      const out: string[] = []
      for (const b of root.querySelectorAll('button[aria-label^="Editar canal"]')) {
        const m = b.getAttribute('aria-label')?.match(/Editar canal (.+)$/)
        if (m) out.push(m[1])
      }
      return out
    })
  }

  const antes = await nomes()
  const dupsAntes = antes.filter((n, i) => antes.indexOf(n) !== i)
  expect(dupsAntes, `já havia duplicata: ${dupsAntes}`).toEqual([])

  // cria um canal novo
  await dialog.getByRole('button', { name: /Criar canal|Criar o primeiro canal/ }).first().click()
  const modal = page.getByRole('dialog', { name: /Criar canal/ })
  await expect(modal).toBeVisible()
  await modal.getByLabel('Nome do canal').fill('teste-dedup')
  await modal.getByRole('button', { name: 'Criar canal' }).click()
  await expect(modal).toBeHidden({ timeout: 10000 })

  const depois = await nomes()
  expect(depois.length, `antes ${antes.length}, depois ${depois.length}`).toBe(antes.length + 1)
  const dupsDepois = depois.filter((n, i) => depois.indexOf(n) !== i)
  expect(dupsDepois, `duplicou ao criar: ${dupsDepois}`).toEqual([])
})

test('painel de bot não duplica canais ao abrir e salvar', async ({ page }) => {
  await criarConta(page, 'Dora')
  await createServerViaWizard(page, 'ServidorBotDup', true)

  const dialog = await abrirConfiguracoes(page)

  // cria um bot para ter painel
  await dialog.getByRole('button', { name: 'Bots' }).click()
  await dialog.getByRole('button', { name: /Criar bot/ }).first().click()
  const modal = page.getByRole('dialog', { name: 'Criar bot' })
  await modal.getByLabel('Nome do bot').fill('BotDup')
  await modal.getByRole('button', { name: 'Criar bot' }).click()
  await expect(modal).toBeHidden({ timeout: 15000 })

  // abre a configuração do bot — é aqui que os canais duplicavam
  await dialog.getByRole('button', { name: /^Configurar BotDup$/ }).click()
  const painel = page.getByRole('dialog', { name: /Configurar BotDup/ })
  await expect(painel).toBeVisible({ timeout: 10000 })

  // Aba de escopos: a lista de canais é a única parte do painel que recebe a
  // prop `channels`. Cada canal é um `<label>` com um checkbox dentro, então
  // contamos labels que CONTÊM checkbox — o título do card também é um label
  // textual e contaminaria a contagem.
  await painel.getByRole('tab', { name: /Escopos/ }).click()
  const nomes = await painel.evaluate((root: HTMLElement) => {
    const out: string[] = []
    for (const lb of root.querySelectorAll('label')) {
      if (!lb.querySelector('input[type="checkbox"]')) continue
      const t = (lb.textContent ?? '').trim()
      if (t) out.push(t)
    }
    return out
  })
  expect(nomes.length, 'a aba de escopos deveria listar canais').toBeGreaterThan(0)
  const dups = nomes.filter((n, i) => nomes.indexOf(n) !== i)
  expect(dups, `canais duplicados no painel do bot: ${JSON.stringify(dups)}`).toEqual([])
})