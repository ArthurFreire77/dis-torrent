import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { SOUND_MAX_SECONDS, playableSeconds } from '../src/services/soundboardRules.ts'

/**
 * Efeitos prontos: o painel promete "bum, aplausos…" e antes só mostrava chips
 * que mandavam pesquisar no Google. Agora os sons vêm embutidos no app, com
 * licença registrada — e um teste garante que ninguém adiciona áudio sem ela.
 */

const builtin = readFileSync(new URL('../src-tauri/src/sound_builtin.rs', import.meta.url), 'utf8')
const sources = JSON.parse(
  readFileSync(new URL('../src-tauri/sounds/SOURCES.json', import.meta.url), 'utf8'),
) as { file: string; license: string; artist: string; page: string }[]

test('o catálogo embutido existe e tem som de verdade', () => {
  assert.match(builtin, /pub const BUILTINS/)
  assert.match(builtin, /include_bytes!/, 'sem include_bytes o som não vai no binário')
  // Nada de sintetizar no lugar do arquivo real.
  assert.doesNotMatch(builtin, /fn boom\(|fn buzina\(|2\.0 \* std::f32/, 'o embutido é arquivo real, não síntese')
})

test('todo arquivo embutido tem licença registrada e permitida', () => {
  assert.ok(sources.length >= 5, 'esperado o conjunto de efeitos prontos')
  for (const s of sources) {
    assert.ok(s.file, 'entrada sem arquivo')
    assert.ok(
      /^(CC0|CC BY|Public domain)/.test(s.license),
      `${s.file} com licença não permitida: ${s.license}`,
    )
    assert.ok(s.artist?.trim(), `${s.file} sem autor registrado`)
    assert.match(s.page, /^https:\/\/commons\.wikimedia\.org\//, `${s.file} sem página de origem`)
  }
})

test('efeito embutido mais longo que o teto é cortado, não recusado', () => {
  // Aplausos reais têm 17s; o painel corta em SOUND_MAX_SECONDS.
  assert.equal(playableSeconds(17.29), SOUND_MAX_SECONDS)
  assert.equal(playableSeconds(8), 8)
  assert.equal(playableSeconds(0), SOUND_MAX_SECONDS)
  assert.equal(playableSeconds(Number.NaN), SOUND_MAX_SECONDS)
})

test('o painel não oferece mais chip que "manda pesquisar no Google"', () => {
  const panel = readFileSync(
    new URL('../src/components/calls/SoundboardPanel.tsx', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(panel, /SOUND_SUGGESTIONS/, 'os chips falsos saíram; os sons são reais')
  assert.match(panel, /embutido/, 'a UI precisa distinguir o que vem com o app')
  assert.match(panel, /builtin:/, 'o botão de apagar não pode aparecer para embutido')
})

test('o Rust recusa apagar efeito embutido', () => {
  const sound = readFileSync(
    new URL('../src-tauri/src/commands_sound.rs', import.meta.url),
    'utf8',
  )
  assert.match(sound, /is_builtin/, 'sound_delete precisa checar o prefixo')
  assert.match(sound, /embutido não pode ser apagado/)
})
