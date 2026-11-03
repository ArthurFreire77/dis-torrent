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

test('entrar no canal abre par mesmo quando o roster chega atrasado', () => {
  // Causa do "só conecta de segunda": o voiceStates era lido uma única vez e,
  // na estreia, ainda não tinha o outro peer — ninguém abria o PC. As janelas
  // vão até 25 s porque o prompt de microfone pode levar mais que 8 s.
  assert.match(manager, /catchUpVoiceRoster\(callId, communityId, channelId\)/, 'catch-up é chamado no join')
  const bloco = manager.slice(manager.indexOf('private catchUpVoiceRoster'))
  assert.ok(bloco.length > 0, 'a função existe')
  assert.match(bloco.slice(0, 2200), /createPC\(fp, callId, true\)/, 'abre o par que faltava')
  assert.match(bloco.slice(0, 1400), /\[1200, 3000, 6000, 10000, 16000, 25000\]/, 'tenta em seis janelas')
})

test('roster que chega durante o prompt do microfone não é descartado', () => {
  // `joinVoice` anuncia a entrada ANTES de esperar o getUserMedia. O outro
  // lado responde na hora e o evento chegava sem `this.state` — era jogado
  // fora e ninguém abria par na estreia ("só conecta na segunda").
  assert.match(manager, /pendingVoiceJoins = new Map/, 'existe a fila do roster adiantado')
  const joined = manager.slice(manager.indexOf('private onVoiceParticipantJoined'))
  assert.match(joined.slice(0, 1400), /pendingVoiceJoins\.get\(callId\)/, 'guarda em vez de descartar')
  const joinVoice = manager.slice(manager.indexOf('async joinVoice'))
  assert.match(joinVoice.slice(0, 12000), /const adiantados = this\.pendingVoiceJoins\.get\(callId\)/, 'drena no join')
})

test('captura de mídia é serializada (AbortError ao abrir câmera/mic)', () => {
  // `getUserMedia` concorrente ABORTA o anterior: entrar na chamada e clicar
  // na câmera no mesmo instante derrubava o pedido com AbortError.
  assert.match(manager, /function comFilaDeCaptura/, 'existe a fila global de captura')
  assert.match(manager, /let capturaFila: Promise<unknown> = Promise\.resolve\(\)/)
  const get = manager.slice(manager.indexOf('async function getLocalMedia('))
  assert.match(get.slice(0, 400), /comFilaDeCaptura\(/, 'getLocalMedia passa pela fila')
})

test('aparelho salvo que sumiu volta para o padrão (câmera que "não abre")', () => {
  const get = manager.slice(manager.indexOf('async function getLocalMediaInner('))
  const bloco = get.slice(0, 3200)
  assert.match(bloco, /usaDeviceExato/, 'detecta preferência de device salva')
  assert.match(bloco, /setCallMediaPrefs\(\{ audioInputId: '', videoInputId: '' \}\)/, 'esquece o device morto')
  assert.match(bloco, /videoConstraintsFromPrefs\(\{ \.\.\.mediaPrefs, videoInputId: '' \}\)/, 'recaptura no padrão')
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

test('em chamada de canal o painel lateral fica fora da tela unificada', () => {
  // O painel de controles agora vive DENTRO da tela unificada (coluna fixa e
  // estreita); o painel lateral só existe fora dela.
  assert.match(shell, /resolveVoiceLayout\(/)
  assert.match(shell, /painelLateralVisivel \? \(callPanelSize/, 'a margem do conteúdo segue o layout')
})
