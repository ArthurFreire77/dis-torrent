// Chamadas com MUITA gente, servidores GIGANTES e "não cair da call".
//
// Três relatos do dono:
// 1. "garanta que funcione com várias pessoas a chamada";
// 2. "um cara do server com 300 mil pessoas não entra — não deve aparecer
//    ninguém, imagina aparecer 300 mil pessoas nessa tela, isso vale para todo
//    server";
// 3. "depois de um tempo eu caio da call" (não pode acontecer nunca).

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  colunasQueCabem,
  linhasNecessarias,
  precisaRolar,
  CARD_MIN_WIDTH_PX,
  MAX_COLS,
} from '../src/services/callGrid.ts'
import {
  windowMembers,
  LIMITE_MEMBROS,
  memberWindowLabel,
} from '../src/services/memberWindow.ts'

const manager = readFileSync('src/services/callManager.ts', 'utf8')
const shell = readFileSync('src/designs/ThemeShell.tsx', 'utf8')
const mobile = readFileSync('src/mobile/MobileShell.tsx', 'utf8')
const grid = readFileSync('src/components/calls/CallTilesGrid.tsx', 'utf8')
const storage = readFileSync('distorrent-core/src/storage.rs', 'utf8')

// ---------- grade da chamada: várias pessoas ----------

test('uma pessoa ocupa a tela sozinha', () => {
  assert.equal(colunasQueCabem(1, 1600), 1)
})

test('duas pessoas NÃO viram duas colunas em janela estreita', () => {
  // 380px úteis: um card de 300px + gap não cabe duas vezes.
  assert.equal(colunasQueCabem(2, 380), 1, 'empilha em vez de esmagar')
})

test('duas pessoas em monitor largo usam as duas colunas', () => {
  assert.equal(colunasQueCabem(2, 1600), 2)
})

test('seis pessoas distribuem sem passar do teto de colunas', () => {
  const cols = colunasQueCabem(6, 1600)
  assert.ok(cols >= 2 && cols <= MAX_COLS, `colunas=${cols}`)
  assert.equal(linhasNecessarias(6, cols), Math.ceil(6 / cols))
})

test('nunca devolve zero colunas (grade não pode sumir)', () => {
  for (const n of [0, 1, 2, 9, 40]) {
    for (const w of [0, 100, 320, 800, 3840]) {
      const c = colunasQueCabem(n, w)
      assert.ok(c >= 1, `n=${n} w=${w} -> ${c}`)
    }
  }
})

test('largura desconhecida (SSR) usa o palpite quadrado', () => {
  assert.equal(colunasQueCabem(4, 0), 2)
  assert.equal(colunasQueCabem(9, 0), 3)
})

test('muita gente ROLA em vez de esmagar os cards', () => {
  // 12 pessoas em 1 coluna (janela estreita) não cabem em 600px de altura.
  assert.equal(precisaRolar(12, 1, 600), true)
  assert.equal(precisaRolar(1, 1, 600), false)
})

test('o card tem largura mínima confortável', () => {
  assert.ok(CARD_MIN_WIDTH_PX >= 240, 'card não pode virar selo')
  // Em 900px úteis cabem 2 (300*2 + gap), não 3.
  assert.equal(colunasQueCabem(9, 900), 2)
})

test('a grade MEDE a área (não confia só em sqrt)', () => {
  assert.match(grid, /ResizeObserver/, 'acompanha o tamanho da área')
  assert.match(grid, /colunasQueCabem\(tiles.length, largura/, 'passa a largura real')
})

// ---------- servidor gigante: 300 mil membros ----------

test('300 mil membros nunca viram 300 mil linhas', () => {
  const gigante = Array.from({ length: 300_000 }, (_, i) => [`fp${i}`, `user${i}`] as [string, string])
  const w = windowMembers(gigante)
  assert.equal(w.visiveis.length, LIMITE_MEMBROS, 'renderiza no máximo o teto')
  assert.equal(w.restantes, 300_000 - LIMITE_MEMBROS)
  assert.equal(w.total, 300_000, 'o número mostrado continua honesto')
})

test('lista pequena passa inteira (sem paginação desnecessária)', () => {
  const w = windowMembers([1, 2, 3])
  assert.equal(w.visiveis.length, 3)
  assert.equal(w.restantes, 0)
  assert.equal(memberWindowLabel(w), null, 'sem rodapé quando cabe tudo')
})

test('num servidor gigante, EU e os online aparecem primeiro', () => {
  const lista = Array.from({ length: 5000 }, (_, i) => ({ id: `p${i}`, eu: i === 4321, on: i >= 4990 }))
  const w = windowMembers(lista, 10, (m) => m.eu || m.on)
  const ids = w.visiveis.map((m) => m.id)
  assert.ok(ids.includes('p4321'), 'eu nunca sumo da lista')
  // 11 preferidos (eu + 10 online) para 10 vagas: pelo menos um online entra.
  assert.ok(ids.includes('p4990'), 'quem está online aparece antes do resto')
  assert.equal(w.visiveis.length, 10)
  assert.equal(w.restantes, 4990)
})

test('o rodapé diz o total real (não mente)', () => {
  const w = windowMembers(Array.from({ length: 1000 }, (_, i) => i))
  const rotulo = memberWindowLabel(w)
  assert.ok(rotulo && rotulo.includes('1.000'), `rodapé: ${rotulo}`)
})

test('o painel de membros do PC corta ANTES do map', () => {
  assert.match(shell, /windowMembers\(onlineMembers, LIMITE_MEMBROS\)/)
  assert.match(shell, /janelaOnline\.visiveis\.map\(memberRow\)/)
  assert.match(shell, /não listados/)
})

test('a lista de @menção também tem teto', () => {
  assert.match(shell, /windowMembers\(activeComm\.members \?\? \[\], LIMITE_MEMBROS/)
})

test('o celular tem o mesmo teto', () => {
  assert.match(mobile, /windowMembers\(/)
  assert.match(mobile, /janela\.restantes > 0/)
})

// ---------- não cair da call ----------

test('CANAL DE VOZ nunca é encerrado por tempo', () => {
  // O watchdog de reconexão chamava leave() após 30 s sem mídia. Num canal a
  // pessoa está ESPERANDO gente entrar — cair sozinha é o bug relatado.
  const bloco = manager.slice(manager.indexOf('private startReconnectWatchdog'))
  const trecho = bloco.slice(0, 1800)
  assert.match(trecho, /if \(callId && callId\.startsWith\('voice-'\)\) return/, 'não arma no canal')
  assert.match(trecho, /if \(st\.callId\.startsWith\('voice-'\)\) return/, 'e não encerra se disparar')
})

test('o watchdog de conexão não desiste no canal vazio', () => {
  const bloco = manager.slice(manager.indexOf('private onConnectWatchdogFire'))
  assert.match(bloco.slice(0, 3000), /CANAL VAZIO NÃO É FALHA/)
  assert.doesNotMatch(bloco.slice(0, 3000), /ninguém conectou a mídia ainda/)
})

// ---------- presença de voz expira (fantasma) ----------

test('voice_states tem prazo de validade por re-anúncio', () => {
  assert.match(storage, /VOICE_PRESENCE_TTL_MS/)
  assert.match(storage, /announced_at/)
  // A leitura remove o que parou de re-anunciar — é o "secura" fantasma.
  const li = storage.slice(storage.indexOf('pub fn list_voice_states'))
  assert.match(li.slice(0, 1600), /DELETE FROM voice_states/)
  assert.match(li.slice(0, 1600), /announced_at < \?3/)
})

test('o re-anúncio do motor renova o prazo', () => {
  const set = storage.slice(storage.indexOf('pub fn set_voice_state'))
  assert.match(set.slice(0, 900), /announced_at=excluded\.announced_at/, 'upsert renova o carimbo')
})
