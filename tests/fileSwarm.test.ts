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
  assert.equal(validateAnnounce(1024 * 1024, 4), null)
  assert.equal(validateAnnounce(1, 1), null)
  assert.equal(validateAnnounce(MAX_FILE_SIZE, Math.ceil(MAX_FILE_SIZE / CHUNK)), null)
})

test('validateAnnounce recusa tamanho e contagem incoerentes', () => {
  assert.ok(validateAnnounce(1024 * 1024, 3))
  assert.ok(validateAnnounce(1024 * 1024, 5))
  assert.ok(validateAnnounce(MAX_FILE_SIZE + 1, Math.ceil((MAX_FILE_SIZE + 1) / CHUNK)))
  assert.ok(validateAnnounce(NaN, 1))
  assert.ok(validateAnnounce(-1, 1))
  assert.ok(validateAnnounce(100, 0))
  assert.ok(validateAnnounce(100, MAX_CHUNKS + 1))
})

test('o último bloco é menor e o número de chunks bate', () => {
  const size = 600 * 1024
  const chunks = Math.ceil(size / CHUNK)
  assert.equal(chunks, 3)
  assert.equal(validateAnnounce(size, chunks), null)
  const ultimo = size - (chunks - 1) * CHUNK
  assert.equal(ultimo, 88 * 1024)
  assert.ok(ultimo < CHUNK)
})

test('chave do spool é única por arquivo e por bloco', () => {
  assert.equal(spoolKey('file-a', 0), 'swarm:file-a:0')
  assert.notEqual(spoolKey('file-a', 1), spoolKey('file-a', 0))
  assert.notEqual(spoolKey('file-a', 0), spoolKey('file-b', 0))
  assert.notEqual(spoolKey('file-a', 12), spoolKey('file-a1', 2))
})

test('corpo da mensagem carrega metadados e volta igual (round-trip)', () => {
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
  assert.ok(mediaAutoFetchCap('a.jpg') < mediaAutoFetchCap('a.mp4'))
  assert.equal(mediaAutoFetchCap('a.jpg'), 12 * 1024 * 1024)
  assert.equal(mediaAutoFetchCap('a.mp4'), 40 * 1024 * 1024)
})

test('formatFileSize é legível e não perde a unidade', () => {
  assert.equal(formatFileSize(512), '512 B')
  assert.match(formatFileSize(2048), /KB/)
  assert.match(formatFileSize(5 * 1024 * 1024), /MB/)
})
