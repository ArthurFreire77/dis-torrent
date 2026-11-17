import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  dark, mobileDark, resolveTheme, themedPalette, setThemeSource, refreshActiveTheme,
  normalizeHex, readableOn, shade, isLightSurface, activeTokens,
  PRESET_THEMES, THEME_CHOICES, type ThemeName,
} from '../src/shared/theme.ts'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

afterEach(() => {
  setThemeSource(null)
  refreshActiveTheme()
})

describe('tema: presets continuam íntegros', () => {
  it('dark/light preservam os hex de produção', () => {
    assert.equal(dark.accent, '#5865f2')
    assert.equal(dark.main, '#313338')
    assert.equal(resolveTheme('light').main, '#ffffff')
  })

  it('todo preset listado na galeria existe e tem nome', () => {
    for (const id of THEME_CHOICES) {
      assert.ok(PRESET_THEMES[id], `preset ${id} ausente`)
      assert.ok(PRESET_THEMES[id].name.length > 0, `preset ${id} sem nome`)
    }
  })

  it('preset escuro no celular mantém a paleta própria do mobile', () => {
    assert.equal(resolveTheme('dark', undefined, undefined, 'mobile').main, mobileDark.main)
    assert.equal(resolveTheme('dark', undefined, undefined, 'desktop').main, '#313338')
  })
})

describe('tema personalizado: a base é respeitada', () => {
  it('custom sobre o tema claro NÃO volta para fundo escuro', () => {
    const t = resolveTheme('custom', { accent: '#ff0000' }, 'light')
    assert.equal(t.accent, '#ff0000')
    assert.equal(t.main, '#ffffff', 'custom deve partir da base clara')
  })

  it('sem base explícita o padrão continua escuro', () => {
    assert.equal(resolveTheme('custom', { accent: '#ff0000' }).main, dark.main)
  })

  it('custom sobre preset herda o fundo do preset', () => {
    const t = resolveTheme('custom', { accent: '#ff0000' }, 'ocean')
    assert.equal(t.main, PRESET_THEMES.ocean.tokens.main)
    assert.equal(t.accent, '#ff0000')
  })

  it('base inválida cai no escuro em vez de quebrar', () => {
    const t = resolveTheme('custom', { accent: '#ff0000' }, 'nao-existe' as ThemeName)
    assert.equal(t.main, dark.main)
  })
})

describe('paleta viva: a cor do tema chega nos módulos', () => {
  it('themedPalette devolve o token do tema ativo, não o literal do import', () => {
    setThemeSource(() => ({ theme: 'ocean' as ThemeName, customTheme: {} }))
    const pal = themedPalette({ accent: '#5865f2', main: '#313338' })
    assert.equal(pal.accent, PRESET_THEMES.ocean.tokens.accent)
    assert.equal(pal.main, PRESET_THEMES.ocean.tokens.main)
  })

  it('custom com accent próprio chega na paleta', () => {
    setThemeSource(() => ({ theme: 'custom' as ThemeName, customTheme: { accent: '#00ff88' }, customBase: 'dark' }))
    assert.equal(themedPalette({ accent: '#5865f2' }).accent, '#00ff88')
  })

  it('chave que não é token do tema cai no fallback do componente', () => {
    setThemeSource(() => ({ theme: 'dark' as ThemeName, customTheme: {} }))
    const pal = themedPalette({ mentionBg: 'rgba(1,2,3,.5)', accent: '#5865f2' })
    assert.equal(pal.mentionBg, 'rgba(1,2,3,.5)')
  })

  it('a paleta acompanha a troca de tema (não fica congelada)', () => {
    setThemeSource(() => ({ theme: 'forest' as ThemeName, customTheme: {} }))
    const pal = themedPalette({ accent: '#5865f2' })
    assert.equal(pal.accent, PRESET_THEMES.forest.tokens.accent)
    setThemeSource(() => ({ theme: 'sunset' as ThemeName, customTheme: {} }))
    assert.equal(pal.accent, PRESET_THEMES.sunset.tokens.accent)
  })

  it('o mobile usa a base mobile, o desktop a base de desktop', () => {
    setThemeSource(() => ({ theme: 'dark' as ThemeName, customTheme: {} }))
    assert.equal(themedPalette({ main: '#0' }, 'mobile').main, mobileDark.main)
    assert.equal(themedPalette({ main: '#0' }, 'desktop').main, dark.main)
    assert.equal(activeTokens('mobile').main, mobileDark.main)
  })
})

describe('cores: validação e contraste', () => {
  it('normalizeHex aceita 3 e 6 dígitos, recusa o resto', () => {
    assert.equal(normalizeHex('#abc'), '#aabbcc')
    assert.equal(normalizeHex('#AABBCC'), '#aabbcc')
    assert.equal(normalizeHex('  #5865f2  '), '#5865f2')
    assert.equal(normalizeHex('#12345'), null)
    assert.equal(normalizeHex('red'), null)
    assert.equal(normalizeHex('javascript:alert(1)'), null)
    assert.equal(normalizeHex(''), null)
  })

  it('readableOn escolhe texto legível nos extremos', () => {
    assert.equal(readableOn('#ffffff'), '#111214')
    assert.equal(readableOn('#000000'), '#ffffff')
    assert.equal(isLightSurface('#ffffff'), true)
    assert.equal(isLightSurface('#1e1f22'), false)
  })

  it('shade clareia e escurece sem sair do intervalo', () => {
    assert.equal(shade('#000000', 0.5), '#808080')
    assert.equal(shade('#ffffff', -0.5), '#808080')
    assert.equal(shade('#123456', 0), '#123456')
  })
})

describe('a UI lê a paleta do tema (não um literal congelado)', () => {
  it('o shell do desktop usa a paleta viva', () => {
    const src = read('src/designs/ThemeShell.tsx')
    assert.match(src, /const t = themedPalette\(\{/, 'desktop precisa da paleta reativa')
    assert.match(src, /useThemeRevision\(/, 'desktop publica o tema')
  })

  it('o shell do mobile usa a paleta viva e o tema mobile', () => {
    const src = read('src/mobile/MobileShell.tsx')
    assert.match(src, /const t = themedPalette\(\{/, 'mobile precisa da paleta reativa')
    assert.match(src, /useThemeRevision\('mobile'\)/, 'mobile publica o tema na superfície certa')
  })

  it('o mobile não esconde mais o seletor de tema', () => {
    const src = read('src/mobile/MobileShell.tsx')
    assert.doesNotMatch(src, /<AppearanceSettings[^>]*hideTheme/, 'o celular precisa trocar de tema')
  })

  it('os componentes memoizados do mobile assinam a paleta', () => {
    const src = read('src/mobile/MobileShell.tsx')
    assert.match(src, /const ConvRow = memo\(function ConvRow[\s\S]{0,900}usePalette\(\)/)
    assert.match(src, /const FriendRow = memo\(function FriendRow[\s\S]{0,600}usePalette\(\)/)
  })

  it('diálogos e painéis usam a paleta do tema', () => {
    for (const f of [
      'src/components/UpdateSettingsBox.tsx',
      'src/components/DownloadsPanel.tsx',
      'src/components/ConnectionDiagnostics.tsx',
      'src/components/social/socialTheme.tsx',
      'src/mobile/MobileMessage.tsx',
      'src/shared/ui.tsx',
    ]) {
      assert.match(read(f), /themedPalette\(\{/, `${f} ficou com cor fixa`)
    }
  })
})

describe('CSS: os botões seguem o tema', () => {
  it('o CSS mobile usa as variáveis de tema', () => {
    const css = read('src/styles/mobile.css')
    assert.match(css, /\.m-btn\s*\{\s*background: var\(--dt-accent/, 'botão principal segue o tema')
    assert.match(css, /\.m-tab\.on\s*\{[\s\S]{0,120}var\(--dt-accent/, 'aba ativa segue o tema')
    assert.match(css, /\.m-input:focus\s*\{[\s\S]{0,120}var\(--dt-accent/, 'foco do input segue o tema')
  })

  it('o CSS global usa as variáveis de tema nos controles principais', () => {
    const css = read('src/styles/global.css')
    assert.match(css, /\.composer-icon\.send\{\s*background:var\(--dt-accent/)
    assert.match(css, /\.add-btn\{\s*background:var\(--dt-green/)
  })
})

describe('editor de cores: aplica de verdade', () => {
  const src = () => read('src/components/prefs/AppearanceSettings.tsx')

  it('tem destaque rápido que deriva as cores com contraste', () => {
    assert.match(src(), /themeFromAccent\(/, 'atalho de cor de destaque')
    assert.match(src(), /accentHover:\s*shade\(/, 'o hover é derivado, não fixo')
  })

  it('mostra prévia montada com os tokens em edição', () => {
    assert.match(src(), /preview\.accent/, 'prévia usa a cor em rascunho')
    assert.match(src(), /Ficou assim o seu tema/, 'prévia real, não só quadradinhos')
  })

  it('não guarda o tema em dois lugares (prefs é a fonte)', () => {
    assert.doesNotMatch(src(), /localStorage/, 'o localStorage duplicava o tema')
  })

  it('preserva a base ao redefinir', () => {
    assert.match(src(), /customBase/, 'a base do personalizado é mantida')
    assert.match(src(), /Voltar ao /, 'rótulo diz para onde volta')
  })
})
