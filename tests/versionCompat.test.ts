import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  JANELA_COMPAT,
  distanciaEntreVersoes,
  versoesCompativeis,
  avisoForaDaJanela,
  podeUsarRecurso,
  RECURSO_MIN_VERSAO,
} from '../src/services/versionCompat.ts'

const engine = [
  readFileSync('distorrent-core/src/net/engine.rs', 'utf8'),
  ...readdirSync('distorrent-core/src/net/engine')
    .filter((f) => f.endsWith('.rs') && !f.includes('test'))
    .map((f) => readFileSync(`distorrent-core/src/net/engine/${f}`, 'utf8')),
].join('\n')
const protocol = readFileSync('distorrent-core/src/protocol.rs', 'utf8')

test('a janela é de 5 releases', () => {
  assert.equal(JANELA_COMPAT, 5)
})

test('conta a distância em releases do patch', () => {
  assert.equal(distanciaEntreVersoes('1.1.47-pre-alpha', '1.1.43-pre-alpha'), 4)
  assert.equal(distanciaEntreVersoes('1.1.47', '1.1.47-pre-alpha'), 0)
  assert.equal(distanciaEntreVersoes('v1.1.50', '1.1.44-pre-alpha'), 6)
})

test('1.47 e 1.43 CONVERSAM (o caso exato do dono)', () => {
  assert.equal(versoesCompativeis('1.1.47-pre-alpha', '1.1.43-pre-alpha'), true)
})

test('cinco de distância ainda conversa; seis já está fora', () => {
  assert.equal(versoesCompativeis('1.1.49-pre-alpha', '1.1.44-pre-alpha'), true, '5 de distância')
  assert.equal(versoesCompativeis('1.1.50-pre-alpha', '1.1.44-pre-alpha'), false, '6 de distância')
})

test('versão ilegível não bloqueia (melhor tentar e falhar honesto)', () => {
  assert.equal(versoesCompativeis('1.1.47', ''), true)
  assert.equal(versoesCompativeis('1.1.47', 'qualquer-coisa'), true)
})

test('mudança de major/minor está fora da janela', () => {
  assert.equal(versoesCompativeis('1.1.47', '2.0.0'), false)
  assert.equal(versoesCompativeis('1.1.47', '1.2.47'), false)
})

test('o aviso honesto diz o que fazer', () => {
  assert.equal(avisoForaDaJanela('1.1.47', '1.1.43'), null, 'dentro da janela: sem aviso')
  const aviso = avisoForaDaJanela('1.1.50', '1.1.40')
  assert.ok(aviso && /5 versões/.test(aviso), `aviso: ${aviso}`)
})

test('recurso novo NÃO vai para peer antigo que não o entende', () => {
  const min = RECURSO_MIN_VERSAO.voiceVideoFrame
  assert.equal(podeUsarRecurso('voiceVideoFrame', min), true, 'na versão mínima: pode')
  assert.equal(podeUsarRecurso('voiceVideoFrame', '1.1.20'), false, 'antes da mínima: NÃO')
  assert.equal(podeUsarRecurso('voiceVideoFrame', ''), false, 'sem versão declarada: NÃO')
})

test('recurso disponível só a partir da versão que o introduziu', () => {
  assert.equal(podeUsarRecurso('reciboLeitura', '1.1.30'), true)
  assert.equal(podeUsarRecurso('reciboLeitura', '1.1.29'), false)
  assert.equal(podeUsarRecurso('reciboLeitura', '1.1.47'), true, 'mais novo também pode')
})

test('o handshake anuncia a versão do protocolo (campo com default)', () => {
  const hello = protocol.slice(protocol.indexOf('pub struct Hello'), protocol.indexOf('pub struct HelloAck'))
  assert.match(hello, /proto_v: u32/)
  assert.match(hello, /#\[serde\(default\)\]/, 'default para peers antigos')
})

test('o handshake tolera peer sem proto_v (legado = 0)', () => {
  const helloAck = protocol.slice(protocol.indexOf('pub struct HelloAck'), protocol.indexOf('pub struct HelloOk'))
  assert.match(helloAck, /#\[serde\(default\)\]/)
})

test('frame desconhecido é IGNORADO, não derruba a sessão', () => {
  const i = engine.indexOf('let frame: SecureFrame = match serde_json::from_slice(&payload)')
  assert.ok(i > 0, 'achou o ponto de desserialização')
  const bloco = engine.slice(i, i + 240)
  assert.match(bloco, /Err\(_\) => return/, 'erro de frame não propaga')
})

test('campos novos em frames são OPCIONAIS para o outro lado', () => {
  const bloco = protocol.slice(protocol.indexOf('FileAnnounce'), protocol.indexOf('FileAnnounce') + 900)
  assert.match(bloco, /chunk_hashes/)
  const opcional = /#\[serde\(default\)\]/.test(bloco) || /chunk_hashes: Option</.test(bloco)
  assert.ok(opcional, 'campo novo não pode ser obrigatório')
})
