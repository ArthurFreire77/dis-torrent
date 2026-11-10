import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

// Fio do soundboard: garante que o botão não volte a ser só estado.

const callManager = readFileSync(new URL('../src/services/callManager.ts', import.meta.url), 'utf8')
const soundboard = readFileSync(new URL('../src/services/soundboard.ts', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../src/components/calls/SoundboardPanel.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../src/designs/ThemeShell.tsx', import.meta.url), 'utf8')
const mobile = readFileSync(new URL('../src/mobile/MobileShell.tsx', import.meta.url), 'utf8')
const rust = readFileSync(new URL('../src-tauri/src/commands_sound.rs', import.meta.url), 'utf8')

describe('soundboard: mixagem na chamada', () => {
  test('o efeito entra na track do mic via replaceTrack (sem renegociar)', () => {
    assert.match(callManager, /ensureSoundboardSink\(\)/, 'cria o nó de mixagem')
    assert.match(callManager, /createMediaStreamDestination\(\)/, 'usa Web Audio para mixar')
    assert.match(callManager, /replaceTrack\(mixed\)/, 'troca a track enviada pela mixada')
    assert.match(callManager, /playSound\(/, 'o painel chama playSound')
  })

  test('não troca a track de áudio da TELA pela mixada', () => {
    assert.match(
      callManager,
      /screenAudioSenders\.get\(pc\) === sender\) continue/,
      'o sender da tela não pode ser sequestrado pelo soundboard',
    )
  })

  test('limpeza fecha o contexto e desliga o sink', () => {
    assert.match(callManager, /private stopSoundboard\(\)/)
    assert.match(callManager, /try \{ this\.stopSoundboard\(\) \}/, 'cleanup chama stopSoundboard')
  })

  test('sink é revalidado quando o microfone morre ou é trocado', () => {
    assert.match(
      callManager,
      /this\.sfxDestination && this\.sfxMicTrack === mic\) return/,
      'sem revalidar, o efeito tocava num grafo que ninguém enviava',
    )
    assert.match(callManager, /this\.sfxMicTrack = mic/, 'guarda a track usada pelo sink')
  })

  test('sem mic o som toca só local (a UI avisa, não mente)', () => {
    assert.match(callManager, /soundboardLive\(\)/, 'expõe o estado real do sink')
    assert.match(panel, /microfone fechado/, 'avisa que tocou só para você')
  })
})

describe('soundboard: segurança do arquivo', () => {
  test('Rust revalida magic bytes e tamanho, não confia na extensão', () => {
    assert.match(rust, /fn sniff_audio/)
    assert.match(rust, /MAX_SOUND_BYTES/)
    assert.match(rust, /MAX_SOUND_SECONDS/)
    assert.match(rust, /"MZ"/, 'executável é citado como caso rejeitado')
  })

  test('download só por https e com teto de bytes', () => {
    assert.match(rust, /starts_with\("https:\/\/"\)/)
    assert.match(rust, /content_length\(\)/)
    assert.match(soundboard, /sound_download/)
  })

  test('id do som é validado antes de tocar o disco', () => {
    assert.match(rust, /id de som inválido/)
    assert.match(rust, /is_ascii_alphanumeric\(\) \|\| c == '-'/)
  })

  test('som não vira path traversal', () => {
    assert.doesNotMatch(rust, /std::fs::read\(&id\)/, 'nunca lê o id como caminho')
  })
})

describe('soundboard: UI presente nos dois shells', () => {
  test('desktop tem o botão e o painel', () => {
    assert.match(shell, /SoundboardPanel/)
    assert.match(shell, /setShowSoundboard/)
  })

  test('mobile também (antes só existia no desktop)', () => {
    assert.match(mobile, /SoundboardPanel/)
    assert.match(mobile, /mobile-soundboard/)
  })

  test('no celular o botão também fica na barra do microfone', () => {
    const canal = readFileSync(new URL('../src/mobile/MobileCallChannel.tsx', import.meta.url), 'utf8')
    const barra = canal.slice(canal.indexOf('if (inCall) {'))
    const mic = barra.indexOf('onClick={onToggleMute}')
    const efeitos = barra.indexOf('onClick={onSoundboard}')
    assert.ok(mic > 0, 'o microfone existe na barra')
    assert.ok(efeitos > mic, 'efeitos vêm depois do microfone')
    assert.match(barra, /icon="music"/)
  })

  test('o painel flutua na tela (não fica preso dentro de um popover escondido)', () => {
    assert.match(panel, /position: 'fixed'/, 'o painel antigo usava absolute dentro de uma div sem posição')
    assert.match(panel, /Escape/, 'Esc fecha o painel')
    assert.match(panel, /zIndex: 199/, 'camada de clique-fora fecha ao clicar fora')
    assert.match(panel, /onClose/, 'o backdrop usa o onClose recebido')
  })

  test('fechar ao clicar fora não escurece nem bloqueia a chamada', () => {
    const backdrop = panel.slice(panel.indexOf('zIndex: 199'))
    assert.match(backdrop.slice(0, 200), /background: 'transparent'/, 'sem fundo escuro sobre a chamada')
  })

  test('o botão de efeitos vive na barra de controles, junto do microfone', () => {
    const stage = readFileSync(new URL('../src/components/calls/VoiceStage.tsx', import.meta.url), 'utf8')
    const barra = stage.slice(stage.indexOf('{inCall ? ('))
    const mic = barra.indexOf('onClick={onToggleMute}')
    const efeitos = barra.indexOf('onClick={onSoundboard}')
    assert.ok(mic > 0, 'o botão de microfone existe na barra')
    assert.ok(efeitos > 0, 'o botão de efeitos existe na barra')
    assert.ok(
      efeitos > mic,
      'os efeitos vêm depois do microfone na mesma barra de controles',
    )
    assert.match(barra, /Icons\.music/, 'usa o ícone de música, não fones')
  })

  test('o botão de efeitos NÃO fica mais escondido no painel de extras', () => {
    assert.doesNotMatch(
      shell,
      /Efeitos<\/button>/,
      'o botão antigo (no painel de extras, que ficava oculto) foi removido',
    )
    assert.match(shell, /onSoundboard=/, 'o shell passa o botão para a barra da chamada')
  })
})
