import { test, expect, type Page } from '@playwright/test'

// Regressão dos bugs achados auditando a camada social v3 contra o app real.
// Cada teste abaixo falhava antes do fix e trava a correção.

async function createAccount(page: Page, name: string) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 })
  await page.getByPlaceholder('Seu nome').fill(name)
  await page.getByRole('button', { name: 'Criar conta' }).click()
  await expect(page).toHaveURL(/\/d\/forge/, { timeout: 15000 })
}

async function createServer(page: Page, name: string): Promise<void> {
  await page.getByTitle('Adicionar um servidor').click()
  await page.getByText('Criar meu próprio', { exact: false }).click()
  const wizard = page.getByRole('dialog', { name: 'Criar servidor' })
  await expect(wizard).toBeVisible({ timeout: 10000 })
  await wizard.getByPlaceholder('ex.: cantinho dos amigos').fill(name)
  await wizard.getByRole('button', { name: 'Continuar' }).click()
  await wizard.getByRole('button', { name: 'Continuar' }).click()
  await wizard.getByRole('button', { name: 'Continuar' }).click()
  await wizard.getByRole('button', { name: 'Criar servidor' }).click()
  await expect(wizard.getByText('Servidor criado', { exact: false })).toBeVisible({ timeout: 15000 })
  await wizard.getByRole('button', { name: 'Concluir' }).click()
  await expect(wizard).toBeHidden({ timeout: 10000 })
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

  // O bug: createCommunity criava o canal na tupla da comunidade E nos extras,
  // com ids DIFERENTES. O merge casa por id, então os dois apareciam.
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
  // "fn main()" deve aparecer UMA vez: dentro do <pre>, não também solto abaixo.
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

  // O bug: o auto-resize só rodava no onChange, e limpar após o envio é um
  // setInput('') programático — a caixa ficava alta para sempre.
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
  // O bug: o popover usava bottom:calc(100%) sem ancestral position:relative,
  // então era posicionado pelo viewport e caía com y negativo (fora da tela).
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

  // O bug: a âncora da enquete na lista dava índice negativo, então nenhuma
  // aparecia mesmo com o poll criado no motor.
  const cartao = page.locator('[data-mid]').last()
  await expect(cartao.getByText('Qual runtime prefere?')).toBeVisible({ timeout: 8000 })
  await expect(cartao.getByRole('button', { name: /Tokio/ })).toBeVisible()

  await cartao.getByRole('button', { name: /Tokio/ }).click()
  // O bug 2: o tally devolvia os índices escolhidos como se fossem contagens,
  // então 1 voto produzia 0% em todas as opções.
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
  await page.getByText('✏️ Editar').click()
  const campo = linha.locator('textarea')
  await campo.fill('texto editado')
  await linha.getByRole('button', { name: 'salvar' }).click()
  await expect(page.locator('[data-mid]').first()).toContainText('texto editado')
  await expect(page.locator('[data-mid]').first().locator('text=(editado)')).toBeVisible()

  await page.locator('[data-mid]').first().click({ button: 'right' })
  await page.getByText('🗑 Apagar').click()
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
  await expect(page.locator('[data-mid]').first().locator('text=📌')).toBeVisible({ timeout: 8000 })

  await page.getByTitle(/Mensagens fixadas/).click()
  await expect(page.getByText(/Mensagens fixadas \(1\)/)).toBeVisible({ timeout: 8000 })
  // O texto aparece duas vezes (a conversa atrás e o card do pin): o que
  // importa é o card do painel.
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