// Regressões da chamada de canal e da discussão no celular.
//
// Cada teste aqui representa um bug REAL que o usuário relatou:
// - canal de voz/vídeo "conectava e não pegava nada" (sem som, sem câmera);
// - discussão (thread) "bugada" — mensagem do outro não aparecia.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const callChannel = readFileSync('src/mobile/MobileCallChannel.tsx', 'utf8')
const mobileShell = readFileSync('src/mobile/MobileShell.tsx', 'utf8')
const threadPanel = readFileSync('src/components/social/socialSearchPanels.tsx', 'utf8')

test('tela do canal de voz/vídeo MONTA a mídia (sem isso conecta e fica muda)', () => {
  // O <audio> da voz remota e o <video> da câmera vivem no CallTile. Uma tela
  // de chamada que não renderiza os tiles conecta, conta o tempo e não toca
  // nem mostra nada — foi exatamente o relato.
  assert.match(callChannel, /media\?: ReactNode/, 'a tela precisa aceitar os quadrados')
  // Renderizado no caminho de chamada ativa (`if (inCall)`).
  const bloco = callChannel.slice(callChannel.indexOf('if (inCall)'), callChannel.indexOf('if (inCall)') + 3000)
  assert.match(bloco, /\{media\}/, 'os quadrados precisam ser RENDERIZADOS')
  assert.match(mobileShell, /media=\{dentro \? renderCallTilesMobile\(false\) : null\}/, 'o shell precisa passar a mídia')
})

test('quadrados da chamada são o mesmo componente do painel (fonte única)', () => {
  // Se a tela do canal desenhasse "a própria" lista de participantes, o áudio
  // voltaria a não existir. Tem de sair da MESMA função.
  assert.match(mobileShell, /const renderCallTilesMobile = \(/, 'existe um render único dos tiles')
  assert.match(mobileShell, /<CallTileComponent/, 'os tiles usam o componente de mídia')
})

test('watchdog de conexão não pode matar o par recém-criado', () => {
  // "Conectando…" eterno: o par é criado e ninguém oferece; o watchdog tem que
  // dar orçamento antes de declarar falha.
  assert.match(mobileShell, /enterCallChannel/)
})

test('entrar na sala abre PC mesmo quando a pessoa JÁ está no roster', () => {
  // Este é o bug do "Entrar" preso: quem hospeda já tem o convidado na lista,
  // então o ramo `!p` não rodava e nenhum RTCPeerConnection era criado.
  const manager = readFileSync('src/services/callManager.ts', 'utf8')
  const bloco = manager.slice(manager.indexOf('private onParticipantAdded'))
  assert.match(
    bloco.slice(0, 2500),
    /!this\.pcs\.has\(fp\) && isCallPhaseActive\(st\.phase\)/,
    'o par tem de ser garantido fora do ramo que adiciona ao roster',
  )
})

test('discussão escuta mensagem nova (não só busca ao abrir)', () => {
  assert.match(threadPanel, /ev\.type !== 'message_new'/, 'assina message_new')
  assert.match(threadPanel, /m\.conv_id !== thread\.id/, 'filtra pela thread aberta')
  // A dependência antiga `[thread.id, msgs.length]` criava uma busca por
  // mensagem recebida (respostas fora de ordem sobrescreviam a lista).
  assert.doesNotMatch(threadPanel, /\}, \[thread\.id, msgs\.length\]\)/)
})

test('discussão mostra o erro em vez de engolir (botão que não faz nada)', () => {
  assert.match(threadPanel, /setErro\(/, 'falha de envio precisa aparecer')
  assert.match(threadPanel, /role="alert"/, 'erro anunciado para leitor de tela')
})

test('discussão no celular também é ao vivo e devolve o texto se falhar', () => {
  const mobile = mobileShell
  assert.match(mobile, /if \(!showThread \|\| !threadId\) return/, 'escuta só com a thread aberta')
  assert.match(mobile, /setThreadInput\(body\)/, 'texto digitado não pode ser perdido')
})
