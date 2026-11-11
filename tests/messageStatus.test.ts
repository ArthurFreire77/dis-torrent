import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildReceipts,
  conversationKindOf,
  groupStatus,
  receiptGroups,
  receiptsHeadline,
  statusGlyph,
  statusTitle,
  statusTitleFor,
} from '../src/components/social/messageStatus.ts'

const GRUPO = 'g1'

function grupo(members: [string, string][], myFp = 'eu') {
  return buildReceipts({ kind: 'group', members, myFp, membersKnown: true })
}

describe('statusGlyph', () => {
  it('usa os mesmos glifos do WhatsApp nos dois shells', () => {
    assert.equal(statusGlyph('pending'), '🕓')
    assert.equal(statusGlyph('sending'), '○')
    assert.equal(statusGlyph('sent'), '✓')
    assert.equal(statusGlyph('delivered'), '✓✓')
    assert.equal(statusGlyph('read'), '✓✓')
    assert.equal(statusGlyph('failed'), '✕')
    assert.equal(statusGlyph('ok'), '')
    assert.equal(statusGlyph(''), '')
  })
})

describe('statusTitle', () => {
  it('não fala em conexão quando o contato está online', () => {
    const comPeerOnline = statusTitle('pending', true)
    assert.match(comPeerOnline, /online/)
    assert.doesNotMatch(comPeerOnline, /aguardando conexão/)
    assert.match(comPeerOnline, /não confirmou/)
  })

  it('mantém "aguardando conexão" quando o contato está offline', () => {
    assert.equal(statusTitle('pending', false), 'aguardando conexão')
  })

  it('sem informação do contato cai no texto conservador', () => {
    assert.equal(statusTitle('pending'), 'aguardando conexão')
  })

  it('demais estados não dependem da presença do contato', () => {
    for (const st of ['sent', 'delivered', 'read']) {
      assert.equal(statusTitle(st, true), statusTitle(st, false))
    }
    assert.equal(statusTitle('sent'), 'enviada')
    assert.equal(statusTitle('ok'), '')
  })

  it('"enviando" só com o contato online; offline vira fila honesta', () => {
    assert.equal(statusTitle('sending', true), 'enviando…')
    assert.match(statusTitle('sending', false), /fila/)
    assert.match(statusTitle('sending'), /fila/)
  })

  it('falha não promete reenvio imediato: diz que tentará ao reconectar', () => {
    assert.match(statusTitle('failed'), /ao reconectar/)
    assert.doesNotMatch(statusTitle('failed'), /falhou — clique/)
  })
})

describe('conversationKindOf', () => {
  const convs = [
    { id: 'dm1', kind: 'dm' },
    { id: GRUPO, kind: 'group' },
  ]
  const comunidades = [{ channels: [['canal1', 'geral']] as [string, string][] }]

  it('reconhece dm, grupo e canal', () => {
    assert.equal(conversationKindOf('dm1', convs, comunidades), 'dm')
    assert.equal(conversationKindOf(GRUPO, convs, comunidades), 'group')
    assert.equal(conversationKindOf('canal1', convs, comunidades), 'channel')
  })

  it('desconhecido não vira canal por acidente', () => {
    assert.equal(conversationKindOf('nao-existe', convs, comunidades), null)
    assert.equal(conversationKindOf('', convs, comunidades), null)
  })
})

describe('buildReceipts', () => {
  it('tira você da lista e deduplica membros repetidos', () => {
    const v = grupo([['eu', 'Eu'], ['a', 'Ana'], ['a', 'Ana'], ['b', 'Bia']])
    assert.deepEqual(v.others.map((p) => p.fp), ['a', 'b'])
    assert.equal(v.total, 2)
  })

  it('sem recibo conhecido ninguém aparece como leitor', () => {
    const v = grupo([['eu', 'Eu'], ['a', 'Ana'], ['b', 'Bia']])
    assert.equal(v.readers.length, 0)
    assert.equal(v.missing.length, 2)
    assert.equal(v.readersKnown, false)
    assert.equal(v.allRead, false)
  })

  it('só marca quem veio em receipts, respeitando o maior horário', () => {
    const v = buildReceipts({
      kind: 'group',
      members: [['eu', 'Eu'], ['a', 'Ana'], ['b', 'Bia']],
      membersKnown: true,
      myFp: 'eu',
      receipts: [{ fp: 'a', at: 100 }, { fp: 'a', at: 300 }, { fp: 'b', at: 0 }],
    })
    assert.equal(v.readers.length, 1)
    assert.equal(v.readers[0].fp, 'a')
    assert.equal(v.readers[0].readAt, 300)
    assert.deepEqual(v.missing.map((p) => p.fp), ['b'])
  })

  it('ignora recibo de quem não é membro da conversa', () => {
    const v = buildReceipts({
      kind: 'group',
      members: [['eu', 'Eu'], ['a', 'Ana']],
      membersKnown: true,
      myFp: 'eu',
      receipts: [{ fp: 'intruso', at: 500 }],
    })
    assert.equal(v.readers.length, 0)
    assert.equal(v.allRead, false)
  })

  it('allRead só com todos os outros membros confirmados', () => {
    const parcial = buildReceipts({
      kind: 'group',
      members: [['eu', 'Eu'], ['a', 'Ana'], ['b', 'Bia']],
      membersKnown: true,
      myFp: 'eu',
      receipts: [{ fp: 'a', at: 10 }],
    })
    assert.equal(parcial.allRead, false)
    const total = buildReceipts({
      kind: 'group',
      members: [['eu', 'Eu'], ['a', 'Ana'], ['b', 'Bia']],
      membersKnown: true,
      myFp: 'eu',
      receipts: [{ fp: 'a', at: 10 }, { fp: 'b', at: 20 }],
    })
    assert.equal(total.allRead, true)
  })

  it('sozinho no grupo nunca conta como "todos visualizaram"', () => {
    const v = grupo([['eu', 'Eu']])
    assert.equal(v.total, 0)
    assert.equal(v.allRead, false)
  })

  it('com um único outro membro, "read" agregado é dele — sem inventar nos demais', () => {
    const um = buildReceipts({ kind: 'group', members: [['eu', 'Eu'], ['a', 'Ana']], membersKnown: true, myFp: 'eu', status: 'read' })
    assert.equal(um.allRead, true)
    assert.equal(um.readersKnown, true)
    const dois = buildReceipts({ kind: 'group', members: [['eu', 'Eu'], ['a', 'Ana'], ['b', 'Bia']], membersKnown: true, myFp: 'eu', status: 'read' })
    assert.equal(dois.readers.length, 0)
    assert.equal(dois.readersKnown, false)
    assert.equal(dois.allRead, false)
  })

  it('marca que a lista de membros ainda não chegou', () => {
    const v = buildReceipts({ kind: 'group', members: [], membersKnown: false, myFp: 'eu' })
    assert.equal(v.membersKnown, false)
    assert.match(receiptsHeadline(v), /carregando/)
  })
})

describe('groupStatus', () => {
  const tres: [string, string][] = [['eu', 'Eu'], ['a', 'Ana'], ['b', 'Bia']]

  it('não pinta o duplo check de azul enquanto falta alguém', () => {
    const parcial = buildReceipts({ kind: 'group', members: tres, membersKnown: true, myFp: 'eu', receipts: [{ fp: 'a', at: 5 }] })
    assert.equal(groupStatus('read', parcial), 'delivered')
  })

  it('pinta de azul quando todos os outros visualizaram', () => {
    const todos = buildReceipts({
      kind: 'group', members: tres, membersKnown: true, myFp: 'eu',
      receipts: [{ fp: 'a', at: 5 }, { fp: 'b', at: 6 }],
    })
    assert.equal(groupStatus('read', todos), 'read')
  })

  it('nunca promove estado anterior para lido', () => {
    const vazio = buildReceipts({ kind: 'group', members: tres, membersKnown: true, myFp: 'eu' })
    for (const st of ['pending', 'sending', 'sent', 'delivered', 'failed']) {
      assert.equal(groupStatus(st, vazio), st)
    }
  })

  it('em conversa direta a regra antiga continua valendo', () => {
    const dm = buildReceipts({ kind: 'dm', members: [['eu', 'Eu'], ['a', 'Ana']], membersKnown: true, myFp: 'eu' })
    assert.equal(groupStatus('read', dm), 'read')
    assert.equal(groupStatus('delivered', dm), 'delivered')
  })

  it('sem tipo de conversa conhecido não mexe no status', () => {
    const v = buildReceipts({ kind: null, members: tres, membersKnown: true, myFp: 'eu' })
    assert.equal(groupStatus('read', v), 'read')
  })
})

describe('receiptsHeadline', () => {
  it('resume o que o app realmente sabe', () => {
    const tres: [string, string][] = [['eu', 'Eu'], ['a', 'Ana'], ['b', 'Bia']]
    const semRecibo = buildReceipts({ kind: 'group', members: tres, membersKnown: true, myFp: 'eu' })
    assert.equal(receiptsHeadline(semRecibo), 'ainda não chegou nenhuma confirmação de leitura')
    const parcial = buildReceipts({ kind: 'group', members: tres, membersKnown: true, myFp: 'eu', receipts: [{ fp: 'a', at: 1 }] })
    assert.equal(receiptsHeadline(parcial), '1 de 2 visualizaram')
    const todos = buildReceipts({
      kind: 'group', members: tres, membersKnown: true, myFp: 'eu',
      receipts: [{ fp: 'a', at: 1 }, { fp: 'b', at: 2 }],
    })
    assert.equal(receiptsHeadline(todos), 'todos os 2 visualizaram')
    const so = buildReceipts({ kind: 'group', members: [['eu', 'Eu']], membersKnown: true, myFp: 'eu' })
    assert.equal(receiptsHeadline(so), 'sem outros membros')
  })
})

describe('receiptGroups', () => {
  const tres: [string, string][] = [['eu', 'Eu'], ['a', 'Ana'], ['b', 'Bia']]

  it('não acusa de "não visualizou" quem o app ainda não sabe', () => {
    const semRecibo = buildReceipts({ kind: 'group', members: tres, membersKnown: true, myFp: 'eu' })
    const grupos = receiptGroups(semRecibo)
    assert.equal(grupos.length, 1)
    assert.equal(grupos[0].tom, 'unknown')
    assert.equal(grupos[0].pessoas.length, 2)
  })

  it('separa quem visualizou de quem ainda não, com horário', () => {
    const v = buildReceipts({
      kind: 'group', members: tres, membersKnown: true, myFp: 'eu',
      receipts: [{ fp: 'a', at: 777 }],
    })
    const grupos = receiptGroups(v)
    const lidos = grupos.find((g) => g.tom === 'read')
    const faltam = grupos.find((g) => g.tom === 'missing')
    assert.equal(lidos?.pessoas[0].name, 'Ana')
    assert.equal(lidos?.pessoas[0].readAt, 777)
    assert.deepEqual(faltam?.pessoas.map((p) => p.name), ['Bia'])
  })

  it('sem outros membros não há grupo nenhum', () => {
    const v = buildReceipts({ kind: 'group', members: [['eu', 'Eu']], membersKnown: true, myFp: 'eu' })
    assert.deepEqual(receiptGroups(v), [])
  })

  it('todos visualizaram: só o grupo azul', () => {
    const v = buildReceipts({
      kind: 'channel', members: tres, membersKnown: true, myFp: 'eu',
      receipts: [{ fp: 'a', at: 1 }, { fp: 'b', at: 2 }],
    })
    assert.deepEqual(receiptGroups(v).map((g) => g.tom), ['read'])
  })
})

describe('statusTitleFor', () => {
  it('não diz que todos leram quando só parte leu', () => {
    const tres: [string, string][] = [['eu', 'Eu'], ['a', 'Ana'], ['b', 'Bia']]
    const parcial = buildReceipts({ kind: 'group', members: tres, membersKnown: true, myFp: 'eu', receipts: [{ fp: 'a', at: 1 }] })
    assert.match(statusTitleFor('read', parcial), /parte dos membros/)
    const todos = buildReceipts({
      kind: 'group', members: tres, membersKnown: true, myFp: 'eu',
      receipts: [{ fp: 'a', at: 1 }, { fp: 'b', at: 2 }],
    })
    assert.match(statusTitleFor('read', todos), /todos os 2/)
  })

  it('em dm mantém o texto antigo', () => {
    const dm = buildReceipts({ kind: 'dm', members: [['eu', 'Eu'], ['a', 'Ana']], membersKnown: true, myFp: 'eu' })
    assert.equal(statusTitleFor('read', dm), 'lida')
    assert.equal(statusTitleFor('delivered', dm), 'entregue')
    assert.equal(statusTitleFor('pending', dm, true), statusTitle('pending', true))
  })

  it('estados de envio em grupo não prometem leitura', () => {
    const v = buildReceipts({ kind: 'group', members: [['eu', 'Eu'], ['a', 'Ana']], membersKnown: true, myFp: 'eu' })
    assert.match(statusTitleFor('pending', v), /aguardando/)
    assert.match(statusTitleFor('sent', v), /online/)
    assert.match(statusTitleFor('delivered', v), /confirmou leitura|visualizaram/)
    // Com recibo parcial o texto diz quantos já leram, sem prometer "todos".
    const parcial = buildReceipts({
      kind: 'group', members: [['eu', 'Eu'], ['a', 'Ana'], ['b', 'Bia']], membersKnown: true, myFp: 'eu',
      receipts: [{ fp: 'a', at: 5 }],
    })
    const titulo = statusTitleFor('delivered', parcial)
    assert.match(titulo, /1 de 2/)
    assert.doesNotMatch(titulo, /todos/)
  })
})
