// Regressões do "Conectando… eterno" e do layout dos quadrados.
//
// Relato: "ainda continua a conectar só de segunda" + "ficou péssimo o design".
// Duas causas distintas:
// 1. só o fingerprint MAIOR abria o par, e na estreia o outro lado ainda não
//    sabia que eu entrei — ninguém oferecia mídia;
// 2. `getRungSummary` dizia "rota LAN" mesmo sem NENHUM par ICE selecionado, e
//    os quadrados esticavam com `1fr` até a altura toda da janela.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manager = readFileSync('src/services/callManager.ts', 'utf8')
const grid = readFileSync('src/components/calls/CallTilesGrid.tsx', 'utf8')
const shell = readFileSync('src/designs/ThemeShell.tsx', 'utf8')

test('os DOIS lados abrem o par (não só o fingerprint maior)', () => {
  const roster = manager.slice(manager.indexOf('private onVoiceParticipantJoined'))
  const bloco = roster.slice(0, 1800)
  // JSX/quebras de linha: procura as duas condições sem exigir a mesma linha.
  assert.match(bloco, /!this\.pcs\.has\(fp\)/, 'abre o par quando não existe')
  assert.match(bloco, /isCallPhaseActive\(st\.phase\)/, 'só com chamada ativa')
  assert.doesNotMatch(bloco, /this\.myFp > fp/, 'a regra do fp maior não pode mais bloquear a abertura')

  const added = manager.slice(manager.indexOf('private onParticipantAdded'))
  const bloco2 = added.slice(0, 2200)
  assert.match(bloco2, /!this\.pcs\.has\(fp\)/)
  assert.doesNotMatch(bloco2, /this\.myFp > fp/)
})

test('quem ENTRA também oferece (informação fresca do roster)', () => {
  const join = manager.slice(manager.indexOf('async joinVoice'))
  const trecho = join.slice(0, 9000)
  assert.match(trecho, /this\.createPC\(fp, callId, true\)/, 'o joiner abre o par')
  assert.doesNotMatch(trecho, /const iniciar = !!this\.myFp && this\.myFp > fp/, 'sem a trava do fp maior')
})

test('sem par ICE selecionado a rota é "n/d", nunca "LAN"', () => {
  const rota = manager.slice(manager.indexOf('getRungSummary(): string'))
  assert.match(rota.slice(0, 1500), /const comPar = reports\.filter/, 'filtra relatórios sem par')
  assert.match(rota.slice(0, 1500), /if \(!comPar\.length\) return 'n\/d'/, 'sem par = sem rota')
})

test('fase presa em connecting é promovida pelo estado REAL do PC', () => {
  const repair = manager.slice(manager.indexOf('private startMeshRepair'))
  const bloco = repair.slice(0, 1800)
  assert.match(bloco, /if \(st\.phase === 'connecting'\)/, 'só age na fase presa')
  assert.match(bloco, /connectionState/, 'consulta o PC')
  assert.match(bloco, /applyPhase\('media-connected'\)/, 'promove quando há par vivo')
})

test('quadrado tem TETO de altura (não estica a janela toda)', () => {
  assert.match(grid, /maxTileHeight/, 'existe teto configurável')
  assert.match(grid, /height: maxTileHeight/, 'o card recebe a altura do teto')
  assert.match(grid, /flexWrap: 'wrap'/, 'fora do palco a grade é wrap com teto')
})

test('palco do canal de voz PREENCHE a área toda (relato do dono: "completar a tela como nos amigos, num espaço maior")', () => {
  // O `fill` é EXCLUSIVO do centro do canal: painel lateral e mobile
  // continuam com quadrados com teto (o esticamento de antes era lá).
  assert.match(grid, /fill\?: boolean/, 'prop fill existe')
  assert.equal(grid.split('gridAutoRows').length - 1, 1, 'só o palco usa linhas de grid')
  const primeiroUso = shell.indexOf('<CallTilesGrid')
  assert.match(shell.slice(primeiroUso, primeiroUso + 800), /\bfill\b/, 'a grade do canal recebe o modo palco')
})

test('em chamada de canal o painel lateral fica estreito', () => {
  assert.match(shell, /const inChannelCall = inThisCall/)
  assert.match(shell, /inChannelCall \? 300 :/, 'painel de controles tem largura fixa')
})
