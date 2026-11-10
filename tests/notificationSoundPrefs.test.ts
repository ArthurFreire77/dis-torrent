import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Os botões "Som de mensagem" e "Som de chamada" ficavam decorativos: o sfx
// tocava direto, sem consultar a preferência.

const sfx = readFileSync(new URL('../src/services/sfx.ts', import.meta.url), 'utf8')
const prefsComp = readFileSync(new URL('../src/components/prefs/SystemNotificationSettings.tsx', import.meta.url), 'utf8')

test('som de mensagem respeita a preferência notifySounds', () => {
  assert.match(sfx, /function somDeMensagemLigado/, 'existe a checagem')
  const bloco = sfx.slice(sfx.indexOf('export function sfxMessage'))
  assert.match(bloco.slice(0, 300), /somDeMensagemLigado\(\)/, 'sfxMessage consulta a preferência antes de tocar')
})

test('som de chamada respeita a preferência notifyCallSounds', () => {
  assert.match(sfx, /function somDeChamadaLigado/, 'existe a checagem')
  const bloco = sfx.slice(sfx.indexOf('export function sfxRingStart'))
  assert.match(bloco.slice(0, 300), /somDeChamadaLigado\(\)/, 'sfxRingStart não toca com o som desligado')
  assert.match(sfx, /function ringBeep[\s\S]{0,200}somDeChamadaLigado/, 'o bipe repetido também respeita')
})

test('as preferências vêm da fonte única (shared/prefs)', () => {
  assert.match(sfx, /import \{ getPrefs \} from '\.\.\/shared\/prefs\.ts'/)
  assert.match(sfx, /getPrefs\(\)\.notifySounds/)
  assert.match(sfx, /getPrefs\(\)\.notifyCallSounds/)
})

test('a tela de avisos expõe o botão que alimenta cada chave', () => {
  assert.match(prefsComp, /notifySounds: !prefs\.notifySounds/, 'botão de som de mensagem')
  assert.match(prefsComp, /notifyCallSounds: !prefs\.notifyCallSounds/, 'botão de som de chamada')
})
