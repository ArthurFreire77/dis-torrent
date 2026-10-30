// Regras do assistente de criação de servidor (`wizardModel`).
//
// Estes testes existem porque o wizard tinha uma validação PARALELA à do core:
// limite de 60 caracteres contra 64 no Rust, sem checagem de nome reservado e
// sem anti-homoglifo. O resultado prático era o app dizer "tudo certo" e o core
// recusar a criação depois — com uma mensagem genérica. Aqui a regra é a mesma
// que o core aplica (`validateNameLocal` espelha `names.rs`).

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LIMITE_NOME,
  categoryFor,
  channelsAsMeta,
  channelErrorsOf,
  checkServerName,
  initialChannels,
  initialRoles,
  nomeVazio,
  pareceNomeDePessoa,
  slugChannel,
} from '../src/components/server/wizardModel.ts'

test('nome do servidor: limite é o do CORE (64), não um número local', () => {
  assert.equal(LIMITE_NOME, 64)
  // 64 caracteres passa; 65 é recusado com mensagem explicando o máximo.
  const ok = checkServerName('a'.repeat(64))
  assert.equal(ok.error, null, '64 caracteres é aceito')
  const longo = checkServerName('a'.repeat(65))
  assert.ok(longo.error, '65 caracteres é recusado')
  assert.match(String(longo.error), /longo|64/)
})

test('nome do servidor: mínimos e vazios vêm da mesma regra do core', () => {
  assert.equal(checkServerName('').error, null, 'campo vazio não mostra erro (só pendência)')
  assert.ok(nomeVazio(' '))
  assert.ok(nomeVazio('ab') === false)
  // Core exige 3 caracteres para servidor; o wizard não pode aceitar menos.
  assert.ok(checkServerName('ab').error, '"ab" é curto para servidor')
  assert.equal(checkServerName('abc').error, null)
})

test('nome do servidor: regras que o wizard antigo não tinha (reservado e bloqueado)', () => {
  // O core recusa nomes que imitam cargo oficial e termos bloqueados. Se o
  // wizard não avisasse, a criação falharia no fim do fluxo.
  assert.ok(checkServerName('admin').error, 'nome reservado é recusado antes de criar')
  assert.ok(checkServerName('moderador').error, 'cargo oficial é recusado')
})

test('nome do servidor: espaço duplo é erro específico, não genérico', () => {
  const r = checkServerName('Meu  Servidor')
  assert.match(String(r.error), /Espaço duplo/)
})

test('nome do servidor: aviso de "nome de pessoa" não bloqueia', () => {
  const r = checkServerName('Arthur')
  assert.equal(r.error, null, 'o aviso não pode impedir a criação')
  assert.ok(r.warning, 'mas precisa avisar')
  // Nome com espaço/tema não dispara o aviso.
  assert.equal(checkServerName('Turma do Arthur').warning, null)
  assert.equal(pareceNomeDePessoa('Arthur'), true)
  assert.equal(pareceNomeDePessoa('arthur'), false, 'minúsculo não parece nome próprio')
})

test('slug de canal: só minúsculas, números e hífen, sem sobras nas pontas', () => {
  assert.equal(slugChannel('  Geral  '), 'geral')
  assert.equal(slugChannel('Avisos & Regras!'), 'avisos-regras')
  assert.equal(slugChannel('---a---b---'), 'a-b')
  assert.equal(slugChannel('Ação'), 'a-o')
  assert.equal(slugChannel(''), '')
})

test('canais: tipo decide a categoria padrão e o canal inicial é texto+geral', () => {
  assert.equal(categoryFor('text'), 'CANAIS DE TEXTO')
  assert.equal(categoryFor('voice'), 'CANAIS DE VOZ')
  assert.equal(categoryFor('video'), 'CANAIS DE VÍDEO')
  const init = initialChannels()
  assert.equal(init.length, 1)
  assert.equal(init[0].name, 'geral')
  assert.equal(init[0].kind, 'text')
})

test('canais: validação usa a MESMA regra do gerenciador de canais', () => {
  const canais = [
    { name: 'geral', kind: 'text' as const, category: 'CANAIS DE TEXTO' },
    { name: 'avisos', kind: 'text' as const, category: 'CANAIS DE TEXTO' },
  ]
  const meta = channelsAsMeta(canais)
  assert.equal(meta.length, 2)
  assert.equal(meta[1].id, '1', 'ids são posicionais, usados para ignorar o próprio canal')
  assert.deepEqual(channelErrorsOf(canais), [null, null], 'nomes distintos passam')

  // Duplicata é detectada nos DOIS lados: quem já existe vê o novo como
  // conflito e vice-versa. É o comportamento correto (o usuário pode renomear
  // qualquer um dos dois), e é o que o gerenciador de canais também faz.
  const duplicados = [
    { name: 'geral', kind: 'text' as const, category: 'CANAIS DE TEXTO' },
    { name: 'GERAL', kind: 'text' as const, category: 'CANAIS DE TEXTO' },
  ]
  const errs = channelErrorsOf(duplicados)
  assert.ok(errs[0], 'o primeiro acusa o conflito')
  assert.ok(errs[1], 'o segundo acusa o conflito')
  assert.match(String(errs[0]), /existe um canal/)
})

test('cargos: os três presets cobrem o essencial e todos vêm ligados', () => {
  const roles = initialRoles()
  assert.deepEqual(roles.map((r) => r.key), ['membro', 'moderador', 'admin'])
  assert.ok(roles.every((r) => r.enabled), 'todos ligados por padrão')
  assert.ok(roles.every((r) => r.why.length > 20), 'cada cargo explica o que faz')
  // Administrador precisa de ADMINISTRATOR; membro NÃO pode ter.
  const admin = roles.find((r) => r.key === 'admin')!
  const membro = roles.find((r) => r.key === 'membro')!
  assert.equal(membro.permissions & (1 << 0), 0, 'membro não é administrador')
  assert.notEqual(admin.permissions & (1 << 0), 0, 'admin tem o bit de administrador')
})
