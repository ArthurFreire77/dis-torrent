import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const callChannel = readFileSync('src/mobile/MobileCallChannel.tsx', 'utf8')
const mobileShell = readFileSync('src/mobile/MobileShell.tsx', 'utf8')
const threadPanel = readFileSync('src/components/social/socialSearchPanels.tsx', 'utf8')

test('tela do canal de voz/vídeo MONTA a mídia (sem isso conecta e fica muda)', () => {
  assert.match(callChannel, /media\?: ReactNode/, 'a tela precisa aceitar os quadrados')
  const bloco = callChannel.slice(callChannel.indexOf('if (inCall)'), callChannel.indexOf('if (inCall)') + 3000)
  assert.match(bloco, /\{media(\s|\})/, 'os quadrados precisam ser RENDERIZADOS')
  assert.match(mobileShell, /media=\{dentro \? renderCallTilesMobile\(false\) : null\}/, 'o shell precisa passar a mídia')
})

test('quadrados da chamada são o mesmo componente do painel (fonte única)', () => {
  assert.match(mobileShell, /const renderCallTilesMobile = \(/, 'existe um render único dos tiles')
  assert.match(mobileShell, /<MobileCallStage/, 'os tiles usam o palco medido do celular')
  const stage = readFileSync('src/mobile/MobileCallStage.tsx', 'utf8')
  assert.match(stage, /<CallTileComponent/, 'o palco usa o componente de mídia')
  assert.doesNotMatch(mobileShell, /height: compact \? 92/, 'sem altura fixa em px (deformava o vídeo)')
})

test('watchdog de conexão não pode matar o par recém-criado', () => {
  assert.match(mobileShell, /enterCallChannel/)
})

test('entrar na sala abre PC mesmo quando a pessoa JÁ está no roster', () => {
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
