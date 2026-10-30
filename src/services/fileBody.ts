// Corpo de mensagem que carrega um anexo.
//
// O arquivo NÃO viaja na mensagem: o corpo leva só o metadado (id, nome,
// tamanho, blocos e hash do arquivo inteiro). Os bytes vêm depois pelo swarm.
//
// Isto é o que o DESTINATÁRIO tem quando o frame `FileAnnounce` se perde: sem
// ele, o card fica eternamente em "aguardando anúncio do swarm" e o botão
// Baixar nunca habilita. Por isso o formato é estável e testado.
//
// Módulo puro (sem `services`, DOM ou IPC) para poder rodar em `node --test`.

import { FILE_MARKER, formatFileSize, type FileMsgMeta } from './fileRules.ts'
import { bytesToBase64 as toBase64, base64ToBytes as fromBase64 } from '../shared/base64.ts'

/** Metadados que vão no corpo (nunca o conteúdo). */
export function encodeFileMeta(meta: FileMsgMeta): string {
  const b64meta = toBase64(new TextEncoder().encode(JSON.stringify(meta)))
  return `\u{1F4CE} ${meta.name} (${formatFileSize(meta.size)}) ${FILE_MARKER}:${b64meta}`
}

/**
 * Lê o metadado do corpo. Devolve `null` para texto comum (sem marcador) e para
 * corpo corrompido — nunca lança, porque isto roda no render de toda mensagem.
 */
export function parseFileBody(body: string): FileMsgMeta | null {
  if (!body || typeof body !== 'string') return null
  const i = body.indexOf(FILE_MARKER + ':')
  if (i < 0) return null
  const token = body.slice(i + FILE_MARKER.length + 1).split(/\s/)[0]
  if (!token) return null
  try {
    const json = new TextDecoder().decode(fromBase64(token))
    const o = JSON.parse(json) as Partial<FileMsgMeta>
    if (typeof o.file_id !== 'string' || !o.file_id) return null
    if (typeof o.name !== 'string' || !o.name) return null
    if (typeof o.size !== 'number' || typeof o.chunks !== 'number' || typeof o.hash !== 'string') return null
    // Coerência mínima: um corpo adulterado não pode prometer um arquivo que o
    // `validateAnnounce` recusaria depois (evita card morto sem explicação).
    if (o.size < 0 || o.chunks <= 0) return null
    return { file_id: o.file_id, name: o.name, size: o.size, chunks: o.chunks, hash: o.hash }
  } catch { return null }
}
