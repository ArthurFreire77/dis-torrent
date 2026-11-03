// Presença REAL na chamada e espera sem "falhar".
//
// Dois relatos do dono com print:
// - um usuário "segura" aparecia na chamada sem estar lá (linha velha do
//   `voice_states`, que é persistente);
// - "eu posso ficar lá na call esperando alguém conectar, o tempo que eu
//   quiser" — o app não podia desistir nem prometer conexão que não existe.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  filterLiveVoiceRows,
  temAlguemVivo,
  contarNaChamada,
  type VoiceRow,
} from '../src/services/voicePresence.ts'

const manager = readFileSync('src/services/callManager.ts', 'utf8')
const stage = readFileSync('src/components/calls/VoiceStage.tsx', 'utf8')
const peersHook = readFileSync('src/components/calls/ChannelVoicePeers.tsx', 'utf8')

const row = (fp: string, muted = false): VoiceRow => ({ fp, muted, deafened: false })
const online = (...fps: string[]) => new Set(fps)

test('fantasma (na voz e offline) não aparece na chamada', () => {
  const rows = [row('eu'), row('segura')]
  const vis = filterLiveVoiceRows(rows, { myFp: 'eu', onlineFps: online('eu') })
  assert.deepEqual(vis.map((r) => r.fp), ['eu'], '"segura" não está online: sai da lista')
})

test('quem está online continua na chamada', () => {
  const rows = [row('eu'), row('amigo')]
  const vis = filterLiveVoiceRows(rows, { myFp: 'eu', onlineFps: online('eu', 'amigo') })
  assert.deepEqual(vis.map((r) => r.fp), ['eu', 'amigo'])
})

test('eu nunca sou removido (posso entrar num canal vazio)', () => {
  const vis = filterLiveVoiceRows([row('eu')], { myFp: 'eu', onlineFps: online() })
  assert.deepEqual(vis.map((r) => r.fp), ['eu'], 'sem sessão com ninguém eu ainda estou aqui')
})

test('sem lista de sessões NÃO se filtra (senão a chamada parece vazia)', () => {
  // No boot/reconexão geral o motor ainda não reportou ninguém: filtrar aqui
  // esconderia todo mundo e o remédio viraria a doença.
  const rows = [row('eu'), row('amigo')]
  const vis = filterLiveVoiceRows(rows, { myFp: 'eu', onlineFps: online(), filtrar: false })
  assert.equal(vis.length, 2)
})

test('só fantasmas: a lista fica vazia e a UI sabe que ninguém está vivo', () => {
  const rows = [row('a'), row('b')]
  assert.equal(temAlguemVivo(rows, 'eu', online('eu')), false)
  assert.equal(contarNaChamada(rows, { myFp: 'eu', onlineFps: online('eu') }), 0)
})

test('o hook de canais aplica o filtro (não basta o comentário)', () => {
  assert.match(peersHook, /filterLiveVoiceRows\(/, 'a lista do canal passa pela regra')
  assert.match(peersHook, /peersList\(\)/, 'cruza com as sessões vivas')
  assert.match(peersHook, /filtrar: online !== null/, 'sem sessões ainda, mostra o que o motor tem')
})

test('canal vazio espera para sempre (sem teto de postergações)', () => {
  // O teto de 3 janelas (~60 s) parava de vigiar o canal vazio. O dono quer
  // poder ficar na call o tempo que quiser.
  const bloco = manager.slice(manager.indexOf('private onConnectWatchdogFire'))
  const trecho = bloco.slice(0, 3000)
  assert.match(trecho, /CANAL VAZIO NÃO É FALHA/, 'o caso está documentado')
  assert.match(trecho, /this\.connectWatchdogGrants = 0/, 'zera o contador em vez de esgotar')
  // E não pode existir o aviso de "ninguém conectou" como desistência.
  assert.doesNotMatch(trecho, /ninguém conectou a mídia ainda/, 'não declara desistência')
})

test('sozinho na chamada a tela diz "Esperando alguém entrar", não "Conectando…"', () => {
  assert.match(stage, /waitingAlone/, 'a tela recebe o estado de espera')
  assert.match(stage, /Esperando alguém entrar/, 'texto honesto')
  assert.match(stage, /pode ficar o tempo que quiser/, 'diz que pode esperar')
  // O badge de fase NÃO aparece quando está sozinho (não há o que conectar).
  assert.match(stage, /waitingAlone \? \(/, 'o badge cede lugar ao texto de espera')
})
