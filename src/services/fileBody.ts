import { FILE_MARKER, formatFileSize, type FileMsgMeta } from './fileRules.ts'
import { bytesToBase64 as toBase64, base64ToBytes as fromBase64 } from '../shared/base64.ts'

export function encodeFileMeta(meta: FileMsgMeta): string {
  const b64meta = toBase64(new TextEncoder().encode(JSON.stringify(meta)))
  return `\u{1F4CE} ${meta.name} (${formatFileSize(meta.size)}) ${FILE_MARKER}:${b64meta}`
}

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
    if (o.size < 0 || o.chunks <= 0) return null
    return { file_id: o.file_id, name: o.name, size: o.size, chunks: o.chunks, hash: o.hash }
  } catch { return null }
}
