import { test, expect, type Page } from '@playwright/test'
import { createServerViaWizard } from './helpers/server'

async function createAccount(page: Page, name: string) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 })
  await page.getByPlaceholder('Seu nome').fill(name)
  await page.getByRole('button', { name: 'Criar conta' }).click()
  await expect(page).toHaveURL(/\/d\/distorrent/, { timeout: 15000 })
}

async function createServer(page: Page, name: string): Promise<void> {
  await createServerViaWizard(page, name)
  await page.locator(`.rail-btn[title="${name}"]`).click()
  await expect(page.locator('.chan-row').first()).toBeVisible({ timeout: 10000 })
}

async function send(page: Page, body: string): Promise<void> {
  const ta = page.getByLabel('Mensagem')
  await ta.click()
  await ta.fill(body)
  await ta.press('Enter')
  await page.waitForTimeout(350)
}

async function seedServerWithMessage(page: Page, name: string, text = 'mensagem de teste'): Promise<void> {
  await createAccount(page, 'Alice')
  await createServer(page, name)
  await send(page, text)
  await expect(page.locator('[data-mid]')).toHaveCount(1, { timeout: 10000 })
}

test('canal não aparece duplicado na sidebar', async ({ page }) => {
  await seedServerWithMessage(page, 'SemDuplicata')

  const nomes = await page.locator('.chan-row').allTextContents()
  const canais = nomes.map((t) => t.trim()).filter((t) => t && !t.includes('Nova thread'))
  expect(canais).toEqual(['geral'])
  expect(new Set(canais).size).toBe(canais.length)
})

test('bloco de código renderiza uma única vez', async ({ page }) => {
  await seedServerWithMessage(page, 'MarkdownOk')

  await send(page, '```rust\nfn main() { println!("oi"); }\n```')

  const bloco = page.locator('[data-mid]').last()
  await expect(bloco.locator('pre').first()).toBeVisible()
  const texto = await bloco.innerText()
  const ocorrencias = texto.split('fn main()').length - 1
  expect(ocorrencias).toBe(1)
})

test('composer volta a uma linha depois de mensagem longa', async ({ page }) => {
  await seedServerWithMessage(page, 'ComposerOk')

  const ta = page.getByLabel('Mensagem')
  const alturaAntes = (await ta.boundingBox())!.height

  await ta.click()
  await ta.fill(Array.from({ length: 12 }, (_, i) => `linha ${i + 1}`).join('\n'))
  await page.waitForTimeout(250)
  const alturaLonga = (await ta.boundingBox())!.height
  expect(alturaLonga).toBeGreaterThan(alturaAntes)

  await ta.press('Enter')
  await page.waitForTimeout(400)

  const alturaDepois = (await page.getByLabel('Mensagem').boundingBox())!.height
  expect(alturaDepois).toBeLessThan(alturaLonga)
  expect(alturaDepois).toBeLessThan(alturaAntes + 12)
})

test('menu do composer abre dentro da janela', async ({ page }) => {
  await seedServerWithMessage(page, 'MenuComposer')

  const mais = page.getByTitle('Mais: arquivo, enquete, emoji')
  await mais.click()

  const item = page.getByRole('button', { name: 'Criar enquete' })
  await expect(item).toBeVisible({ timeout: 5000 })
  const box = (await item.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.height).toBeGreaterThan(0)
})

test('enquete criada aparece na conversa e aceita voto com percentual', async ({ page }) => {
  await seedServerWithMessage(page, 'EnqueteOk')

  await page.getByTitle('Mais: arquivo, enquete, emoji').click()
  await page.getByRole('button', { name: 'Criar enquete' }).click()
  await page.getByPlaceholder('Pergunta').fill('Qual runtime prefere?')
  await page.getByPlaceholder(/Opções/).fill('Tokio\nAxum\nSmol')
  await page.getByRole('button', { name: 'criar', exact: true }).click()

  const cartao = page.locator('[data-mid]').last()
  await expect(cartao.getByText('Qual runtime prefere?')).toBeVisible({ timeout: 8000 })
  await expect(cartao.getByRole('button', { name: /Tokio/ })).toBeVisible()

  await cartao.getByRole('button', { name: /Tokio/ }).click()
  await expect(cartao.getByText('100%')).toBeVisible({ timeout: 8000 })
  await expect(cartao.getByText('0%').first()).toBeVisible()
})

test('reação cria pilha com contador', async ({ page }) => {
  await seedServerWithMessage(page, 'ReacoesOk', 'mensagem para reagir')

  const linha = page.locator('[data-mid]').first()
  await linha.hover()
  await linha.getByTitle('Reagir 👍').click()

  await expect(linageBtn(linha)).toBeVisible({ timeout: 8000 })
})

function linageBtn(linha: import('@playwright/test').Locator) {
  return linha.locator('button').filter({ hasText: /^👍\s*1$/ }).first()
}

test('fixar, editar e apagar mensagem pelo menu de contexto', async ({ page }) => {
  await seedServerWithMessage(page, 'SocialMenu')
  page.on('dialog', (d) => void d.accept())

  const linha = page.locator('[data-mid]').first()
  await linha.click({ button: 'right' })
  await page.getByText('Fixar / desafixar').click()
  await expect(linha.getByTitle('fixada')).toBeVisible({ timeout: 8000 })

  await linha.click({ button: 'right' })
  await page.getByRole('button', { name: 'Editar', exact: true }).click()
  const campo = linha.locator('textarea')
  await campo.fill('texto editado')
  await linha.getByRole('button', { name: 'salvar' }).click()
  await expect(page.locator('[data-mid]').first()).toContainText('texto editado')
  await expect(page.locator('[data-mid]').first().locator('text=(editado)')).toBeVisible()

  await page.locator('[data-mid]').first().click({ button: 'right' })
  await page.getByRole('button', { name: 'Apagar', exact: true }).click()
  await expect(page.getByText('1 mensagem apagada')).toBeVisible({ timeout: 8000 })
})

test('busca encontra mensagem pelo texto', async ({ page }) => {
  await seedServerWithMessage(page, 'BuscaOk', 'frase unica com a palavra alambique')
  await send(page, 'outra mensagem qualquer')

  await page.getByTitle(/Buscar mensagens/).click()
  const campo = page.getByRole('textbox').first()
  await campo.fill('alambique')
  await expect(page.getByText('frase unica com a palavra alambique')).toBeVisible({ timeout: 8000 })
})

test('painel de pins lista a mensagem fixada', async ({ page }) => {
  await seedServerWithMessage(page, 'PinsOk', 'mensagem importante')

  await page.locator('[data-mid]').first().click({ button: 'right' })
  await page.getByText('Fixar / desafixar').click()
  await expect(page.locator('[data-mid]').first().getByTitle('fixada')).toBeVisible({ timeout: 8000 })

  await page.getByTitle(/Mensagens fixadas/).click()
  await expect(page.getByText(/Mensagens fixadas \(1\)/)).toBeVisible({ timeout: 8000 })
  await expect(page.getByRole('button', { name: /fixado por/ })).toContainText('mensagem importante', { timeout: 8000 })
})

test('thread criada a partir de mensagem abre o painel', async ({ page }) => {
  await seedServerWithMessage(page, 'ThreadsOk', 'msg raiz da thread')

  await page.locator('[data-mid]').first().click({ button: 'right' })
  await page.getByText('Criar thread').click()

  await expect(page.getByText(/thread criada por/i)).toBeVisible({ timeout: 10000 })
  const dialogo = page.getByRole('dialog').filter({ hasText: /thread criada por/i })
  await dialogo.getByPlaceholder(/Mensar em/).fill('resposta na thread')
  await dialogo.getByRole('button', { name: 'Enviar', exact: true }).click()
  await expect(dialogo.getByText('resposta na thread')).toBeVisible({ timeout: 8000 })
})
