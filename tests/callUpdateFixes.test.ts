import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manager = readFileSync('src/services/callManager.ts', 'utf8')
const fCalls = readFileSync('distorrent-core/src/net/engine/f_calls.rs', 'utf8')
const updaterChecks = readFileSync('src-tauri/src/updater_checks.rs', 'utf8')
const updaterDownload = readFileSync('src-tauri/src/updater_download.rs', 'utf8')

function blocoDe(nome: string, tamanho = 1600): string {
  const i = manager.indexOf(nome)
  assert.ok(i > 0, `não achei ${nome}`)
  return manager.slice(i, i + tamanho)
}

test('call_accepted que chega antes do state fica guardado', () => {
  const bind = blocoDe("if (ev.type === 'call_accepted')", 500)
  assert.match(bind, /pendingAccepts\.set/, 'one-shot no fio: perder aqui é para sempre')
  const start = blocoDe('private async startInner', 6000)
  assert.match(start, /pendingAccepts\.delete\(callId\)/, 'o state novo consome o accept guardado')
})

test('duplo start() não cria dois call_id', () => {
  const start = manager.slice(manager.indexOf('async start(kind: CallKind'))
  assert.match(start.slice(0, 600), /if \(this\.starting\) throw/, 'duplo clique é recusado')
  const inner = blocoDe('private async startInner', 400)
  assert.ok(inner.length > 0, 'o corpo real ficou no startInner')
})

test('answer perdida volta pelo retry do chamador', () => {
  const reenvio = blocoDe('private async reenviarAnswerLocal', 1400)
  assert.match(reenvio, /remote\.sdp !== offerSdp/, 'compara SDP puro com SDP puro')
  const offer = blocoDe('private async handleOffer', 2400)
  assert.match(offer, /reenviarAnswerLocal\(fromFp, callId, pc, offer\.sdp\)/, 'passa o SDP parseado')
})

test('o core reenvia CallAccept quando o invite repete', () => {
  const invite = fCalls.slice(fCalls.indexOf('SecureFrame::CallInvite'), fCalls.indexOf('SecureFrame::CallRinging {'))
  assert.match(invite, /is_in_call\(&call_id, &engine\.identity\.fingerprint\)/, 'só reenvia se eu já aceitei')
  assert.match(invite, /SecureFrame::CallAccept/, 'o accept é reenviado de forma idempotente')
  assert.match(invite, /get_call_host/, 'não reenvia para quem é o host da chamada')
})

test('a checagem do update preserva o instalador já baixado', () => {
  assert.match(updaterChecks, /caminho_existente/, 'o path do pending é reaproveitado')
  assert.doesNotMatch(
    updaterChecks,
    /path: String::new\(\),/,
    'zerar o path fazia o apply recusar um download válido',
  )
  assert.match(updaterDownload, /não consegui registrar o instalador baixado/, 'gravar o pending não é silencioso')
})

test('label_mismatch não acusa release normal', () => {
  assert.match(
    updaterChecks,
    /mesma_versao\(&rotulo, &body\.version\)/,
    "'1.1.70' e '1.1.70-pre-alpha' são a mesma versão",
  )
  assert.doesNotMatch(updaterChecks, /rotulo != body\.version/, 'igualdade de string acusava toda release')
})
