// Dois bugs relatados em uso real, travados por contrato de código:
//   1. trocar de câmera no Windows dava "em uso por outro app";
//   2. sair da chamada do servidor e clicar em entrar não fazia nada.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manager = readFileSync('src/services/callManager.ts', 'utf8')

function blocoDe(nome: string, tamanho = 2200): string {
  const i = manager.indexOf(nome)
  assert.ok(i > 0, `não achei ${nome}`)
  return manager.slice(i, i + tamanho)
}

test('trocar de câmera SOLTA a antiga antes de abrir a nova', () => {
  const bloco = blocoDe('if (trocouCam && camTrack && camTrack.readyState ===')
  const solta = bloco.indexOf('camTrack.stop()')
  const abre = bloco.indexOf('getLocalMedia({ video: videoConstraintsFromPrefs(depois) })')
  assert.ok(solta > 0, 'precisa soltar a câmera antiga')
  assert.ok(abre > 0, 'precisa abrir a nova')
  assert.ok(
    solta < abre,
    'abrir a nova com a antiga viva dá NotReadableError ("em uso por outro app") no Windows',
  )
})

test('troca de câmera que falha tenta reabrir a anterior', () => {
  const bloco = blocoDe('if (trocouCam && camTrack && camTrack.readyState ===', 3000)
  assert.match(bloco, /videoInputId: fpAntigo/, 'volta para o device que estava funcionando')
  assert.match(bloco, /setCallMediaPrefs\(\{ videoInputId: antes\.videoInputId \}\)/, 'restaura a preferência')
})

test('câmera ocupada é retentada ANTES de cair para só voz', () => {
  const iRetry = manager.indexOf("NotReadableError') {")
  const iFallbackGeral = manager.indexOf(
    "if (merged.video && (e as Error)?.name !== 'OverconstrainedError')",
  )
  assert.ok(iRetry > 0, 'existe tratamento de NotReadableError')
  assert.ok(iFallbackGeral > 0, 'existe o fallback genérico')
  assert.ok(
    iRetry < iFallbackGeral,
    'o fallback "só voz" devolvia stream sem vídeo e o retry nunca rodava',
  )
  const retry = manager.slice(iRetry, iFallbackGeral)
  assert.match(retry, /for \(const espera of \[/, 'tenta mais de uma vez')
  assert.match(retry, /getUserMedia\(merged\)/, 'retenta com vídeo')
})

test('sair do canal limpa o estado que impedia reentrar', () => {
  const bloco = blocoDe('async leaveVoice', 3200)
  assert.match(bloco, /this\.leavingCalls\.clear\(\)/, 'sem isto a reentrada era tratada como duplicada')
  assert.match(bloco, /this\.accepting\.clear\(\)/)
  assert.match(bloco, /this\.cameraBusy = false/, 'troca travada impedia ligar a câmera depois')
  assert.match(bloco, /this\.state = null/)
})

test('a grade usa o stream local mesmo antes do primeiro quadro', () => {
  const tiles = readFileSync('src/services/callTiles.ts', 'utf8')
  assert.match(
    tiles,
    /localCameraStream/,
    'o card local depende do localStream chegar ao state',
  )
  const bind = manager.slice(manager.indexOf('bind(cb:'), manager.indexOf('bind(cb:') + 1600)
  assert.match(bind, /withScreen\.localStream = this\.localStream/, 'bind injeta o stream no state')
})

test('troca de rede (wifi ↔ dados) refaz a rota da chamada', () => {
  const bind = manager.slice(manager.indexOf('bind(cb:'), manager.indexOf('bind(cb:') + 1800)
  assert.match(bind, /addEventListener\('online'/, 'volta da rede dispara recuperação')
  assert.match(bind, /addEventListener\('offline'/, 'perda de rede é detectada na hora')
  const rec = manager.slice(manager.indexOf('private onNetworkChanged'), manager.indexOf('private onNetworkChanged') + 1200)
  assert.match(
    rec,
    /restartIceAll\(st\.callId, true\)/,
    'precisa forçar TODOS os PCs: o ICE antigo fica "connected" com a rota morta',
  )
  assert.match(rec, /ultimaTrocaDeRede/, 'debounce evita renegociar em loop')
})

test('celular: chamada dentro da conversa não esconde as mensagens', () => {
  const mobile = readFileSync('src/mobile/MobileShell.tsx', 'utf8')
  assert.match(
    mobile,
    /renderCallTilesMobile\(callPanelSize === 'compact', true\)/,
    'o painel da conversa usa o modo tira (vídeos em faixa)',
  )
  const stage = readFileSync('src/mobile/MobileCallStage.tsx', 'utf8')
  assert.match(stage, /if \(strip\)/, 'existe o modo tira')
  assert.match(stage, /height: stripHeight/, 'a faixa tem altura fixa e deixa o resto para o chat')
})
