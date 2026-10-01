// Verificação ISOLADA da camada social no shell mobile.
// Roda com o próprio navegador (headless) — não depende do MCP nem de sessão
// aberta: `npx tsx e2e/social-mobile.spec.ts` ou `node --experimental-strip-types`.
//
// Cobre: texto rico (negrito/código/link/menção/spoiler), reação (toggle e
// estado "minha"), fixar, responder inline, editar, apagar, busca real no
// motor e status personalizado — TODOS contra os serviços reais do modo browser.

import { chromium, type Browser, type Page } from '@playwright/test'

const URL = process.env.FORGE_URL ?? 'http://127.0.0.1:5199/m'
const results: { name: string; ok: boolean; detail?: string }[] = []

function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const FP_ME = 'aaaaaaaaaaaa'
const FP_PEER = 'bbbbbbbbbbbb'

async function seed(page: Page) {
  await page.evaluate(({ me, peer }) => {
    const convs = JSON.parse(localStorage.getItem('forge:conversations') ?? '[]')
    const cid = 'cid-social-e2e'
    if (!convs.find((c: any) => c.id === cid)) {
      convs.push({ id: cid, kind: 'dm', title: 'Peer', peer_fp: peer, created_at: Date.now() })
      localStorage.setItem('forge:conversations', JSON.stringify(convs))
    }
    // o fp real da identidade local (a UI só deixa editar o que EU escrevi)
    const meReal = JSON.parse(localStorage.getItem('forge:identity') ?? '{}')?.fingerprint ?? me
    const now = Date.now()
    const list = [
      { id: 'e1', conv_id: cid, author_fp: peer, body: 'Oi! **negrito** *itálico* `código` e https://example.com', ts: now - 60000, sig: 'x', direction: 'in', status: 'ok' },
      { id: 'e2', conv_id: cid, author_fp: peer, body: '||spoiler secreto|| e @Peer', ts: now - 30000, sig: 'x', direction: 'in', status: 'ok' },
      { id: 'e3', conv_id: cid, author_fp: meReal, body: 'minha mensagem para editar', ts: now - 10000, sig: 'x', direction: 'out', status: 'delivered' },
    ]
    localStorage.setItem('forge:messages', JSON.stringify(list))
  }, { me: FP_ME, peer: FP_PEER })
}

async function openConv(page: Page) {
  await page.goto(URL)
  await page.waitForTimeout(2500)
  const url0 = page.url()
  // Se o perfil isolar tem identidade, o shell abre direto; senão criamos conta.
  const precisaConta = /Criar conta/i.test((await page.locator('body').innerText()).slice(0, 400))
  if (precisaConta) {
    await page.locator('input').first().fill('Tester')
    await page.getByRole('button', { name: /Criar conta/i }).click()
    await page.waitForTimeout(1200)
  } else if (!/Conversar|Início|Amigos|Você/.test(await page.locator('body').innerText())) {
    throw new Error(`app não carregou (url=${url0}): ${(await page.locator('body').innerText()).slice(0, 200)}`)
  }
  await seed(page)
  await page.goto(URL)
  await page.waitForTimeout(600)
  // abre a conversa
  const row = page.locator('text=Toque para conversar').first()
  if (await row.count()) {
    await row.click()
    await page.waitForTimeout(800)
  }
}

async function main() {
  let browser: Browser | null = null
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 414, height: 896 } })
    const erros: string[] = []
    page.on('pageerror', (e) => erros.push(String(e.message)))
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) erros.push(m.text()) })

    await openConv(page)

    const linhas = await page.locator('[id^="mmsg-"]').count()
    check('renderiza 3 mensagens', linhas === 3, `linhas=${linhas}`)

    // ---- texto rico ----
    check('negrito renderizado', (await page.locator('#mmsg-e1 b, #mmsg-e1 strong').count()) > 0)
    check('itálico renderizado', (await page.locator('#mmsg-e1 em, #mmsg-e1 i').count()) > 0)
    check('código inline renderizado', (await page.locator('#mmsg-e1 code').count()) > 0)
    const link = page.locator('#mmsg-e1 a[href="https://example.com"]')
    check("link clicável com rel=noopener", (await link.count()) > 0 && !!((await link.getAttribute("rel")) ?? "").includes("noopener"))
    check('spoiler escondido por padrão', (await page.locator('#mmsg-e2 [aria-label="Spoiler — clique para revelar"]').count()) > 0)

    // ---- reação ----
    await page.locator('#mmsg-e1 button[aria-label="Reagir à mensagem"]').click()
    await page.waitForTimeout(300)
    await page.locator('[role="dialog"] button[aria-label="emoji 👍"]').first().click()
    await page.waitForTimeout(600)
    check('reação cria contador', /👍\s*1/.test((await page.locator('#mmsg-e1').innerText())))
    const highlighted = await page.locator('#mmsg-e1 button:has-text("👍")').first().getAttribute('style')
    check('reação minha fica destacada', !!highlighted?.includes('88, 101, 242') || !!highlighted?.includes('rgba(88,101,242'))
    // toggle: segunda vez remove (clica no chip com a contagem)
    const chip = page.locator('#mmsg-e1 button').filter({ hasText: /👍\s*1/ }).first()
    await chip.click()
    await page.waitForTimeout(800)
    check('reação alterna (remove)', !/👍\s*1/.test((await page.locator('#mmsg-e1').innerText())),
      (await page.locator('#mmsg-e1').innerText()).replace(/\n/g, ' ').slice(0, 60))

    // ---- responder inline ----
    await page.locator('#mmsg-e1 button[aria-label="Ações da mensagem"]').click()
    await page.waitForTimeout(250)
    await page.locator('[role="dialog"] button').filter({ hasText: 'Responder' }).first().click()
    await page.waitForTimeout(300)
    check('barra de resposta aparece', (await page.locator('button[aria-label="Cancelar resposta"]').count()) > 0)
    await page.locator('button[aria-label="Cancelar resposta"]').click()
    await page.waitForTimeout(200)
    check('barra de resposta cancela', (await page.locator('button[aria-label="Cancelar resposta"]').count()) === 0)

    // ---- fixar ----
    await page.locator('#mmsg-e2 button[aria-label="Ações da mensagem"]').click()
    await page.waitForTimeout(250)
    await page.locator('[role="dialog"] button').filter({ hasText: 'Fixar mensagem' }).first().click()
    await page.waitForTimeout(700)
    // a barra de fixadas mostra o TRECHO da mensagem fixada
    check('barra de fixadas aparece', (await page.locator('button:has-text("+") , button').filter({ hasText: /spoiler secreto|secret/ }).count()) > 0
      || (await page.locator('text=/Fixadas \(1\)/').count()) > 0
      || (await page.evaluate(() => {
        const st = localStorage.getItem('forge:msg_meta') ?? ''
        return st.includes('"pinned":true')
      })))

    // ---- editar ----
    await page.locator('#mmsg-e3 button[aria-label="Ações da mensagem"]').click()
    await page.waitForTimeout(250)
    await page.locator('[role="dialog"] button').filter({ hasText: 'Editar' }).first().click()
    await page.waitForTimeout(300)
    const ta = page.locator('textarea[aria-label="Editar mensagem"]')
    check('modo de edição abre', (await ta.count()) > 0)
    await ta.fill('texto editado pela ui')
    await page.locator('button').filter({ hasText: /^salvar$/ }).first().click()
    await page.waitForTimeout(800)
    const txt3 = (await page.locator('#mmsg-e3').innerText()).replace(/\n/g, ' ')
    check('edição aplicada e marcada', txt3.includes('texto editado pela ui') && txt3.includes('(editado)'), txt3.slice(0, 90))

    // ---- apagar ----
    await page.locator('#mmsg-e1 button[aria-label="Ações da mensagem"]').click()
    await page.waitForTimeout(250)
    await page.locator('[role="dialog"] button').filter({ hasText: 'Apagar' }).first().click()
    await page.waitForTimeout(800)
    check('mensagem apagada vira "apagada"', (await page.locator('#mmsg-e1').innerText()).includes('apagada'))

    // ---- busca real ----
    await page.locator('button[aria-label="Buscar nesta conversa"]').click()
    await page.waitForTimeout(300)
    const busca = page.locator('input[aria-label="Buscar mensagens"]')
    check('sheet de busca abre', (await busca.count()) > 0)
    await busca.fill('spoiler')
    await page.waitForTimeout(900)
    const hits = await page.locator('[role="dialog"] button:has(span)').count()
    check('busca encontra mensagem', (await page.locator('[role="dialog"]').innerText()).includes('spoiler'), `hits=${hits}`)
    await page.locator('[role="dialog"] button[aria-label="Fechar"]').click()
    await page.waitForTimeout(300)

    // ---- status / presença ----
    await page.locator('button[aria-label="Mais opções"]').click()
    await page.waitForTimeout(250)
    await page.locator('button').filter({ hasText: 'Meu status' }).first().click()
    await page.waitForTimeout(400)
    check('painel de status abre', (await page.getByText('Meu status').count()) > 0)
    await page.locator('[role="dialog"] button').filter({ hasText: 'Não perturbe' }).first().click()
    await page.waitForTimeout(500)
    const st = await page.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => x.includes('social:presence') || x.includes('forge:presence'))
      return k ? `${k}=${localStorage.getItem(k)}` : 'nenhuma chave de presença'
    })
    check('presença dnd persistida', st.includes('dnd'), st)
    await page.locator('[role="dialog"] button[aria-label="Fechar"]').click()

    check('sem erros de runtime', erros.length === 0, erros.slice(0, 2).join(' | '))

    await page.screenshot({ path: 'docs/screenshots/mobile-social-e2e.png', fullPage: false })
  } finally {
    await browser?.close()
  }

  const falhas = results.filter((r) => !r.ok)
  console.log(`\n${results.length - falhas.length}/${results.length} verificações passaram`)
  if (falhas.length) {
    console.log('FALHAS:')
    for (const f of falhas) console.log(` - ${f.name}${f.detail ? ` (${f.detail})` : ''}`)
    process.exit(1)
  }
}

void main()
