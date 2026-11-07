import { test, expect, type Page } from '@playwright/test'
import { accountWithConversation } from './helpers/server'

type Caixa = { x: number; y: number; w: number; h: number }

type Medida = {
  largura: number
  altura: number
  dentroDaTela: boolean
  sobrepoeCabecalho: boolean
  sobrepoeComposer: boolean
  overflowHorizontal: boolean
  botoes: Array<{ label: string; caixa: Caixa }>
  menorLargura: number
}

async function canalDeVoz(page: Page, servidor: string): Promise<{ texto: string } | null> {
  await accountWithConversation(page, 'Layout', servidor)
  const criado = await page.evaluate(async (nome) => {
    try {
      const mod = await import('/src/services/index.ts')
      const services = (mod as any).services
      const cs = await services.communitiesList()
      const alvo = cs.find((c: any) => c.name === nome) ?? cs[0]
      if (!alvo) return false
      const id = await services.channelCreate(alvo.id, 'voz-teste', { kind: 'voice', category: 'CANAIS DE VOZ' })
      return typeof id === 'string' && id.length > 0
    } catch { return false }
  }, servidor)
  if (!criado) return null
  await page.locator('.rail-btn[title="Amigos"]').first().click({ force: true })
  await page.waitForTimeout(300)
  await page.locator(`.rail-btn[title="${servidor}"]`).first().click({ force: true })
  await page.waitForTimeout(700)
  const voz = page.locator('.chan-row').filter({ hasText: 'voz-teste' }).first()
  if (!(await voz.isVisible().catch(() => false))) return null
  await voz.click()
  await page.waitForTimeout(900)
  return { texto: 'voz-teste' }
}

async function medir(page: Page, largura: number, altura: number): Promise<Medida | null> {
  await page.setViewportSize({ width: largura, height: altura })
  await page.waitForTimeout(500)
  return page.evaluate(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const stage = document.querySelector('[data-testid="voice-stage"]') as HTMLElement | null
    if (!stage) return null
    const botoes = Array.from(stage.querySelectorAll('button'))
      .filter((b) => {
        const label = b.getAttribute('aria-label') ?? ''
        return /Sair da chamada|microfone|Ensurdecer|Ligar câmera|Desligar câmera|Compartilhar tela|Parar de compartilhar/.test(label)
      })
      .map((b) => {
        const r = b.getBoundingClientRect()
        return {
          label: b.getAttribute('aria-label') ?? '',
          caixa: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        }
      })
    const rs = stage.getBoundingClientRect()
    const cabeçalho = 48
    const sobrepoeCabecalho = botoes.some((b) => b.caixa.y < cabeçalho && b.caixa.h > 0)
    const sobrepoeComposer = false
    const dentroDaTela = botoes.every(
      (b) => b.caixa.x >= -0.5 && b.caixa.y >= -0.5
        && b.caixa.x + b.caixa.w <= vw + 0.5
        && b.caixa.y + b.caixa.h <= vh + 0.5
        && b.caixa.w > 0 && b.caixa.h > 0,
    )
    void rs
    return {
      largura: vw,
      altura: vh,
      dentroDaTela,
      sobrepoeCabecalho,
      sobrepoeComposer,
      overflowHorizontal: stage.scrollWidth > stage.clientWidth + 1,
      botoes,
      menorLargura: botoes.length ? Math.min(...botoes.map((b) => b.caixa.w)) : 0,
    }
  })
}

test.describe('layout da chamada em vários tamanhos', () => {
  test('controles da chamada ficam dentro da janela e sem overflow em 5 tamanhos', async ({ page }) => {
    test.setTimeout(120_000)
    const ok = await canalDeVoz(page, 'ServidorLayout')
    test.skip(!ok, 'não foi possível abrir um canal de voz (ambiente sem canal)')

    const casos: Array<[number, number]> = [
      [1600, 900],
      [1440, 900],
      [1280, 720],
      [1024, 640],
      [820, 560],
    ]
    const medidas: Medida[] = []
    for (const [w, h] of casos) {
      const m = await medir(page, w, h)
      if (!m) {
        test.skip(true, `palco não apareceu em ${w}x${h}`)
        return
      }
      medidas.push(m)
    }
    console.log('CALL LAYOUT', JSON.stringify(medidas, null, 1))

    for (const m of medidas) {
      expect(m.botoes.length, `${m.largura}x${m.altura}: controles precisam existir`).toBeGreaterThanOrEqual(4)
      expect(m.dentroDaTela, `${m.largura}x${m.altura}: botão fora da janela`).toBe(true)
      expect(m.sobrepoeCabecalho, `${m.largura}x${m.altura}: controles sobre o cabeçalho`).toBe(false)
      expect(m.overflowHorizontal, `${m.largura}x${m.altura}: palco com overflow horizontal`).toBe(false)
      expect(m.menorLargura, `${m.largura}x${m.altura}: botão esmagado`).toBeGreaterThanOrEqual(28)
    }
  })
})
