// Swarm de arquivos: regras puras e o ciclo de vida do bloco.
//
// O `fileSwarm` importa `services` (que escolhe Tauri x navegador no import),
// então exercitamos aqui as partes que decidem o comportamento da transferência
// sem depender de IPC: validação de anúncio, hashes, política de seeder e o
// estado do bitfield. Essas são exatamente as regras que, quando erradas,
// deixavam o download em 0% para sempre.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateAnnounce, MAX_FILE_SIZE, MAX_CHUNKS, formatFileSize,
  isImageName, isVideoName, isMediaName,
  mediaAutoFetchCap, spoolKey,
} from '../src/services/fileRules.ts'
import { parseFileBody, encodeFileMeta } from '../src/services/fileBody.ts'
import { FILE_MARKER } from '../src/services/fileRules.ts'

const CHUNK = 256 * 1024

test('validateAnnounce aceita um arquivo coerente', () => {
  // 1 MB = 4 blocos de 256 KB
  assert.equal(validateAnnounce(1024 * 1024, 4), null)
  // 1 byte = 1 bloco
  assert.equal(validateAnnounce(1, 1), null)
  // exatamente o teto
  assert.equal(validateAnnounce(MAX_FILE_SIZE, Math.ceil(MAX_FILE_SIZE / CHUNK)), null)
})

test('validateAnnounce recusa tamanho e contagem incoerentes', () => {
  // chunks a mais/menos que o tamanho real: um peer mentindo no anúncio
  assert.ok(validateAnnounce(1024 * 1024, 3))
  assert.ok(validateAnnounce(1024 * 1024, 5))
  // teto anti-DoS
  assert.ok(validateAnnounce(MAX_FILE_SIZE + 1, Math.ceil((MAX_FILE_SIZE + 1) / CHUNK)))
  // lixo
  assert.ok(validateAnnounce(NaN, 1))
  assert.ok(validateAnnounce(-1, 1))
  assert.ok(validateAnnounce(100, 0))
  assert.ok(validateAnnounce(100, MAX_CHUNKS + 1))
})

test('o último bloco é menor e o número de chunks bate', () => {
  // 600 KB = 2 blocos cheios + 88 KB
  const size = 600 * 1024
  const chunks = Math.ceil(size / CHUNK)
  assert.equal(chunks, 3)
  assert.equal(validateAnnounce(size, chunks), null)
  const ultimo = size - (chunks - 1) * CHUNK
  assert.equal(ultimo, 88 * 1024)
  assert.ok(ultimo < CHUNK)
})

test('chave do spool é única por arquivo e por bloco', () => {
  // Um bloco não pode ser confundido com o de outro arquivo, nem com outro
  // índice do mesmo arquivo — era o risco de "bloco no arquivo errado".
  assert.equal(spoolKey('file-a', 0), 'swarm:file-a:0')
  assert.notEqual(spoolKey('file-a', 1), spoolKey('file-a', 0))
  assert.notEqual(spoolKey('file-a', 0), spoolKey('file-b', 0))
  // prefixo de id não colide com outro id que comece igual
  assert.notEqual(spoolKey('file-a', 12), spoolKey('file-a1', 2))
})

test('corpo da mensagem carrega metadados e volta igual (round-trip)', () => {
  // É o caminho pelo qual o DESTINATÁRIO descobre o arquivo quando o frame
  // `FileAnnounce` se perde: se isto quebrar, o card fica "aguardando anúncio".
  const meta = {
    file_id: 'file-abc-123', name: 'foto do gato.png',
    size: 1234, chunks: 1, hash: 'deadbeef',
  }
  const body = encodeFileMeta(meta)
  const back = parseFileBody(body)
  assert.ok(back)
  assert.equal(back!.file_id, meta.file_id)
  assert.equal(back!.name, meta.name)
  assert.equal(back!.size, meta.size)
  assert.equal(back!.chunks, meta.chunks)
  assert.equal(back!.hash, meta.hash)
})

test('parseFileBody ignora corpo comum e corpo corrompido', () => {
  assert.equal(parseFileBody('mensagem normal'), null)
  assert.equal(parseFileBody(''), null)
  assert.equal(parseFileBody(`${FILE_MARKER}:@@@nao-e-base64@@@`), null)
  // base64 válido mas JSON sem os campos obrigatórios
  assert.equal(parseFileBody(`${FILE_MARKER}:${btoa('{"a":1}')}`), null)
})

test('detecção de mídia por nome', () => {
  assert.ok(isImageName('foto.JPG'))
  assert.ok(isImageName('a.png'))
  assert.ok(isVideoName('clipe.mp4'))
  assert.ok(isVideoName('a.webm'))
  assert.ok(isMediaName('x.gif'))
  assert.equal(isMediaName('doc.pdf'), false)
  assert.equal(isImageName('arquivo.exe'), false)
})

test('teto de auto-prévia: imagem menor que vídeo', () => {
  // Acima disso o arquivo só baixa no gesto "Baixar" — nunca em silêncio.
  assert.ok(mediaAutoFetchCap('a.jpg') < mediaAutoFetchCap('a.mp4'))
  assert.equal(mediaAutoFetchCap('a.jpg'), 12 * 1024 * 1024)
  assert.equal(mediaAutoFetchCap('a.mp4'), 40 * 1024 * 1024)
})

test('formatFileSize é legível e não perde a unidade', () => {
  assert.equal(formatFileSize(512), '512 B')
  assert.match(formatFileSize(2048), /KB/)
  assert.match(formatFileSize(5 * 1024 * 1024), /MB/)
})
