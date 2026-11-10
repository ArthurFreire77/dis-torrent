import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  AVATAR_EFFECTS,
  DECORATION_CHOICES,
  EFFECT_CHOICES,
  PROFILE_THEMES,
  THEME_CHOICES,
  effectClass,
  effectStyle,
  normalizeAvatarEffect,
  normalizeDecoration,
  normalizeTheme,
  themeGradient,
} from '../src/shared/profileStyle.ts'

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8')

test('tema do perfil: só a lista fechada entra (peer não injeta CSS)', () => {
  assert.deepEqual([...PROFILE_THEMES], ['none', 'aurora', 'sunset', 'ocean', 'neon', 'forest'])
  assert.equal(normalizeTheme('aurora'), 'aurora')
  assert.equal(normalizeTheme('AURORA'), 'aurora')
  assert.equal(normalizeTheme('linear-gradient(red,blue)'), 'none')
  assert.equal(normalizeTheme('<script>'), 'none')
  assert.equal(normalizeTheme(''), 'none')
})

test('efeito do avatar: só a lista fechada entra', () => {
  assert.deepEqual([...AVATAR_EFFECTS], ['none', 'glow', 'pulse', 'rainbow', 'sparkle'])
  assert.equal(normalizeAvatarEffect('rainbow'), 'rainbow')
  assert.equal(normalizeAvatarEffect('url(javascript:alert1)'), 'none')
})

test('decoração recusa letras e números (não vira apelido fora da moderação)', () => {
  assert.equal(normalizeDecoration('🌸'), '🌸')
  assert.equal(normalizeDecoration('abc'), '', 'letras são recusadas')
  assert.equal(normalizeDecoration('123'), '', 'números são recusados')
  assert.equal(normalizeDecoration('🌸⭐👑🔥'), '', 'mais de 3 grafemas é recusado')
  assert.equal(normalizeDecoration('   '), '')
  assert.equal(normalizeDecoration('\u200b🌸'), '🌸', 'zero-width é removido')
})

test('toda escolha da UI existe no allowlist (senão o core descarta)', () => {
  for (const c of THEME_CHOICES) assert.ok(PROFILE_THEMES.includes(c.id), `tema ${c.id}`)
  for (const c of EFFECT_CHOICES) assert.ok(AVATAR_EFFECTS.includes(c.id), `efeito ${c.id}`)
  for (const d of DECORATION_CHOICES) {
    assert.equal(normalizeDecoration(d), d, `decoração "${d}" precisa sobreviver à validação`)
  }
})

test('o gradiente do tema é determinístico e distinto por tema', () => {
  const aurora = themeGradient('aurora', '#5865f2')
  assert.deepEqual(aurora, themeGradient('aurora', '#000'))
  assert.notDeepEqual(themeGradient('aurora', '#000'), themeGradient('sunset', '#000'))
  assert.deepEqual(themeGradient('none', '#5865f2'), { from: '#5865f2', to: '#1e1f22' })
})

test('a aura usa a COR DO PERFIL, não um azul fixo', () => {
  assert.equal(effectClass('none'), '')
  assert.equal(effectClass('glow'), 'pfx pfx-glow')

  const style = effectStyle('glow', '#ff0000') as Record<string, string> | undefined
  assert.ok(style, 'glow precisa passar a cor')
  assert.equal(style!['--pfx-aura'], '#ff0000', 'a variável leva a cor escolhida')
  assert.equal((effectStyle('pulse', '#23a55a') as Record<string, string>)['--pfx-aura'], '#23a55a')

  assert.equal(effectStyle('none', '#fff'), undefined, 'sem efeito não pinta nada')
  assert.equal(effectStyle('rainbow', '#fff'), undefined, 'arco-íris tem gradiente próprio')
  assert.equal(effectStyle('sparkle', '#fff'), undefined, 'brilhos tem cor própria')
  assert.equal(effectStyle('glow', ''), undefined, 'sem cor, mantém o fallback do CSS')
})

test('o CSS da aura lê a variável (senão a cor do perfil é ignorada)', () => {
  assert.match(css, /\.pfx-glow::before\{[^}]*var\(--pfx-aura/, 'glow usa a variável')
  assert.match(css, /\.pfx-pulse::before\{[^}]*var\(--pfx-aura/, 'pulse usa a variável')
  assert.doesNotMatch(css, /\.pfx-glow::before\{[^}]*#5865f2,/, 'cor fixa no glow era o bug')
})

test('o componente Avatar passa a cor para o estilo da aura', () => {
  const view = readFileSync(new URL('../src/shared/avatarView.tsx', import.meta.url), 'utf8')
  assert.match(view, /effectStyle\(effect, accent/, 'o Avatar repassa a cor de destaque')
  assert.match(view, /\.\.\.effectStyle/, 'o estilo entra no wrapper da aura')
})

test('existe UMA implementação de Avatar (sem cópia que ignora a cor)', () => {
  const primitives = readFileSync(new URL('../src/components/social/socialPrimitives.tsx', import.meta.url), 'utf8')
  assert.match(primitives, /from '\.\.\/\.\.\/shared\/avatarView'/, 'as primitivas delegam para a versão única')
  assert.doesNotMatch(primitives, /effectClass\(effect\)/, 'não reimplementa a aura')
})
