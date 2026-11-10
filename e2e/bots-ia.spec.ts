import { test, expect, type Page } from '@playwright/test'
import { createServerViaWizard } from './helpers/server'

/**
 * O caminho de "bot conectado a uma IA" (comando HTTP com header de
 * autenticação e corpo JSON). Antes, o editor não tinha campo de headers e o
 * `{{raw.args}}` não escapava JSON: a pergunta com aspas quebrava o POST e a
 * API respondia 400 — o bot parecia "bugado" sem erro visível.
 */

async function createAccount(page: Page, name: string) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 })
  await page.getByPlaceholder('Seu nome').fill(name)
  await page.getByRole('button', { name: 'Criar conta' }).click()
  await expect(page).toHaveURL(/\/d\/distorrent/, { timeout: 15000 })
}

async function createBot(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Criar bot', exact: true }).first().click()
  const modal = page.getByRole('dialog', { name: 'Criar bot' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await modal.getByLabel('Nome do bot').fill(name)
  await modal.getByRole('button', { name: 'Criar bot', exact: true }).click()
  await expect(modal).toBeHidden({ timeout: 10000 })
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 15000 })
}

test('painel expõe headers/timeout e o Testar envia o texto escapado para a API', async ({ page }) => {
  let recebido: { auth: string | undefined; body: string | undefined } = {
    auth: undefined,
    body: undefined,
  }

  // API de IA falsa, mas real do ponto de vista do app: exige o header.
  await page.route('**/api.exemplo.com/v1/chat', async (route) => {
    const req = route.request()
    recebido = { auth: req.headers()['authorization'], body: req.postData() ?? undefined }
    if (recebido.auth !== 'Bearer chave-teste') {
      await route.fulfill({ status: 401, body: '{"error":"unauthorized"}' })
      return
    }
    // O JSON do POST tem de ser parseável — é isto que o {{jsonargs}} garante.
    let pergunta = ''
    try {
      pergunta = String(JSON.parse(recebido.body ?? '{}').prompt ?? '')
    } catch {
      await route.fulfill({ status: 400, body: '{"error":"json inválido"}' })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ answer: `eco: ${pergunta}` }),
    })
  })

  await createAccount(page, 'AliceIA')
  await createServerViaWizard(page, 'ServidorIA')

  await page.locator('.server-head').click()
  await page.getByRole('button', { name: 'Bots', exact: true }).click()
  await createBot(page, 'IABot')

  await page.getByRole('button', { name: 'Configurar IABot' }).click()
  const panel = page.getByRole('region', { name: 'Configurar IABot' })
  await expect(panel).toBeVisible({ timeout: 10000 })

  await panel.getByRole('tab', { name: 'Comandos' }).click()
  await panel.getByRole('button', { name: /Adicionar comando/ }).click()
  await panel.getByLabel('Nome do comando 1').fill('ia')
  await panel.getByLabel('Tipo do comando 1').selectOption('http')
  await panel.getByLabel('Método do comando 1').selectOption('POST')
  await panel.getByLabel('URL do comando 1').fill('https://api.exemplo.com/v1/chat')
  await panel.getByLabel('Corpo do comando 1').fill('{"prompt": "{{jsonargs}}"}')
  await panel.getByLabel('Caminho da resposta do comando 1').fill('answer')
  await panel.getByLabel('Template do comando 1').fill('{{value}}')

  // O campo de headers existe (era o que faltava para autenticar numa API).
  const headers = panel.getByLabel('Headers do comando 1')
  await expect(headers).toBeVisible()
  await headers.fill('Authorization: Bearer chave-teste')

  // Timeout em segundos, para LLM.
  await panel.getByLabel('Timeout do comando 1').fill('60')

  // Testar executa sem postar no canal e mostra a resposta.
  await panel.getByLabel('Argumentos de teste do comando 1').fill('o que é "x"?')
  await panel.getByRole('button', { name: 'Testar' }).click()

  await expect(panel.locator('[data-bot-test]')).toContainText('eco: o que é "x"?', {
    timeout: 15000,
  })
  expect(recebido.auth).toBe('Bearer chave-teste')
  // A pergunta chegou com as aspas preservadas e o JSON inteiro.
  expect(JSON.parse(recebido.body ?? '{}').prompt).toBe('o que é "x"?')

  await panel.getByRole('button', { name: 'Salvar', exact: true }).click()
  await expect(panel.getByText('Configuração salva e validada pelo core.')).toBeVisible({
    timeout: 10000,
  })
})
