/*
 * PROVA no app REAL: o painel de chamada não esmaga mais a coluna principal.
 *
 * Mede o chrome fixo de verdade (pai - coluna), aplica a margem da regra NOVA
 * (resolveCallDock) e da ANTIGA (clamp vw), e compara a largura do <textarea>
 * do composer. Nada é gravado no banco.
 */
import { chromium } from 'playwright-core'

const CDP = 'http://127.0.0.1:9222'

function ruleWide(size, w, chrome) {
  const CHROME = typeof chrome === 'number' && chrome > 0 ? chrome : 312
  const MIN = 560
  const livre = Math.max(0, w - CHROME)
  const sobra = livre - MIN
  if (sobra < 300) return 0
  if (size === 'compact') return Math.min(300, sobra)
  if (size === 'expanded') return Math.min(Math.min(720, w * 0.56), sobra)
  return Math.min(Math.min(520, Math.max(320, w * 0.36)), sobra)
}

function oldInset(size, w) {
  if (size === 'compact') return 300
  if (size === 'normal') return Math.min(520, Math.max(320, w * 0.36))
  return Math.min(720, w * 0.56)
}

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 })
const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith('devtools://'))
if (!page) throw new Error('nenhuma página do app')
await page.bringToFront().catch(() => {})

const r = await page.evaluate(
  async ({ ruleWideSrc, oldInsetSrc }) => {
    // eslint-disable-next-line no-new-func
    const ruleWide = new Function('return ' + ruleWideSrc)()
    // eslint-disable-next-line no-new-func
    const oldInset = new Function('return ' + oldInsetSrc)()
    const espera = (ms) => new Promise((res) => setTimeout(res, ms))

    // abre um canal de texto (só navegação)
    let canais = [...document.querySelectorAll('.chan-row')]
    if (canais.length === 0) {
      for (const b of [...document.querySelectorAll('.rail-btn')]) {
        b.click()
        await espera(800)
        if (document.querySelectorAll('.chan-row').length) break
      }
    }
    canais = [...document.querySelectorAll('.chan-row')]
    if (!canais.length) return { ok: false, motivo: 'não abriu canal' }
    canais[0].click()
    await espera(1500)

    const ta = document.querySelector('textarea')
    if (!ta) return { ok: false, motivo: 'composer não apareceu' }

    // A coluna principal é a única que o shell margina: style.transition
    // contém 'margin-right'. Achar pelo DOM evita depender de constante.
    const raiz = [...document.querySelectorAll('div')].find(
      (d) => (d.style.transition || '').includes('margin-right') && d.parentElement && d.parentElement.style.display === 'flex',
    )
    if (!raiz) return { ok: false, motivo: 'não achei a coluna principal' }
    const pai = raiz.parentElement
    const chrome = Math.max(0, Math.round(pai.clientWidth - raiz.clientWidth))
    const margemOriginal = raiz.style.marginRight

    const medirCom = async (margem) => {
      raiz.style.marginRight = margem
      await espera(400)
      return {
        composer: Math.round(ta.getBoundingClientRect().width),
        coluna: Math.round(raiz.clientWidth),
      }
    }

    const casos = []
    for (const size of ['compact', 'normal', 'expanded']) {
      const antigo = oldInset(size, window.innerWidth)
      const novo = ruleWide(size, window.innerWidth, chrome)
      const comAntigo = await medirCom(antigo + 'px')
      const comNovo = await medirCom(novo + 'px')
      casos.push({ size, antigo, novo, comAntigo, comNovo })
    }
    const semPainel = await medirCom('0px')
    raiz.style.marginRight = margemOriginal
    await espera(200)

    return {
      ok: true,
      canal: canais[0].innerText.trim(),
      janela: window.innerWidth,
      chrome,
      semPainel,
      casos,
    }
  },
  { ruleWideSrc: ruleWide.toString(), oldInsetSrc: oldInset.toString() },
)

await browser.close()

if (!r.ok) {
  console.error('não deu para medir: ' + r.motivo)
  process.exit(1)
}

console.log(`canal "${r.canal}" · janela ${r.janela}px · chrome fixo medido ${r.chrome}px`)
console.log(`sem painel: coluna ${r.semPainel.coluna}px, composer ${r.semPainel.composer}px`)
console.log('')
console.log('painel      ANTIGO margem  coluna  composer   |  NOVO margem  coluna  composer')
for (const c of r.casos) {
  console.log(
    `${c.size.padEnd(9)} ${String(c.antigo).padStart(6)}  ${String(c.comAntigo.coluna).padStart(6)}  ${String(c.comAntigo.composer).padStart(8)}   | ` +
      `${String(c.novo).padStart(6)}  ${String(c.comNovo.coluna).padStart(6)}  ${String(c.comNovo.composer).padStart(8)}`,
  )
}
const piorAntigo = Math.min(...r.casos.map((c) => c.comAntigo.composer))
const piorNovo = Math.min(...r.casos.map((c) => c.comNovo.composer))
const novoConfortavel = r.casos.every((c) => c.novo === 0 || c.comNovo.composer >= 300)
console.log('')
console.log(`pior composer — ANTIGO ${piorAntigo}px · NOVO ${piorNovo}px`)
console.log(novoConfortavel ? 'OK: nenhum caso esmaga o composer' : 'FALHOU: ainda esmaga')
process.exit(novoConfortavel ? 0 : 1)
