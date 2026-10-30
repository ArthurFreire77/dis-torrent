// Confere que todo elemento com classe `csw-*` também tem layout INLINE.
//
// Por que isso é um teste e não um detalhe de estilo: um build anterior
// renderizava o wizard sem a folha de estilo e a tela virava uma linha corrida
// de texto ("ServidorSem tema definido…", "1Identidade 2Canais"), deixando o
// usuário sem saber o que cada campo era. A regra abaixo trava essa regressão:
// classes podem existir para hover/mídia, mas NUNCA podem ser a única fonte de
// estrutura.

import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const FILES = [
  'src/components/CreateServerWizard.tsx',
  'src/components/server/wizardSteps.tsx',
  'src/components/server/wizardChannelSteps.tsx',
  'src/components/server/wizardChrome.tsx',
  'src/components/server/wizardSummary.tsx',
]

test('wizard: nenhum elemento depende só da folha de estilo para ter layout', () => {
  const faltando: string[] = []
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8')
    // Analisa o ELEMENTO, não a linha: JSX quebra atributos em linhas separadas
    // e olhar linha a linha daria falso positivo para `className` seguido de
    // `style` no dia seguinte.
    const tags = [...text.matchAll(/<[a-zA-Z][^>]*className="csw-[^"]*"[^>]*>/g)].map((m) => m[0])
    if (!tags.length) continue
    for (const tag of tags) {
      if (!/style=/.test(tag)) {
        const linha = text.slice(0, text.indexOf(tag)).split(/\r?\n/).length
        faltando.push(`${file}:${linha}`)
      }
    }
  }
  assert.deepEqual(faltando, [], `elementos sem layout inline: ${faltando.join(', ')}`)
})

test('wizard: a folha só cuida de hover/foco/mídia, nunca de estrutura', () => {
  const src = readFileSync('src/components/server/wizardStyles.ts', 'utf8')
  const sheet = src.slice(src.indexOf('export const css = `'))
  // Toda regra da folha tem que estar dentro de :hover/:focus/@media, ou ser o
  // ajuste de uma largura mínima que o inline não consegue expressar.
  const selectors = [...sheet.matchAll(/^\.csw-[^{]+\{/gm)].map((m) => m[0].trim())
  const estruturais = selectors.filter(
    (s) => !/:hover|:focus|:active|:disabled|:focus-within/.test(s),
  )
  for (const sel of estruturais) {
    assert.match(
      sel,
      /csw-(cols|side|models|chan|chan-name|chan-kind|chan-cat|chan-del|cats|perms|seg-t|role-name|role-top|check|done)/,
      `regra estrutural inesperada na folha: ${sel}`,
    )
  }
})
