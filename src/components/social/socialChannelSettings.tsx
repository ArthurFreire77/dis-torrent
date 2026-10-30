// Configuração do canal (slowmode, NSFW, emojis).
//
// Extraído de `Social.tsx` (que tinha 1508 linhas e 27 exports) por
// `scripts/split-social.mjs`. O conteúdo é o MESMO — a divisão é só de
// responsabilidade: um arquivo por assunto, para achar e revisar sem rolar
// 1,5 mil linhas. `Social.tsx` continua reexportando tudo, então nenhum
// importador precisou mudar.

import React, { useEffect, useState } from 'react'
import type { ChannelMeta, EmojiView } from '../../services/models'
import { T } from './socialTheme'
import { Field, Modal, btnPrimary, inputStyle } from './socialPrimitives'

// Cabeçalho de grupo dentro do seletor de emoji.
const pickerHead: React.CSSProperties = {
  fontSize: 10, fontWeight: 800, color: T.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6,
}
import { services } from '../../services'

// ============================== SLOWMODE / EMOJI ==============================

export function ChannelSettingsModal({ communityId, channel, isOwner, onClose, onToast }: {
  communityId: string
  channel: ChannelMeta
  isOwner: boolean
  onClose: () => void
  onToast: (s: string) => void
}) {
  const [slow, setSlow] = useState(0)
  const [nsfw, setNsfw] = useState(false)
  const [emojiName, setEmojiName] = useState('')
  const [emojiChar, setEmojiChar] = useState('')
  const [emojis, setEmojis] = useState<EmojiView[]>([])

  useEffect(() => {
    services.channelCfgGet(channel.id).then(setSlow).catch(() => setSlow(0))
    services.emojiList(communityId).then(setEmojis).catch(() => setEmojis([]))
  }, [channel.id, communityId])

  return (
    <Modal title={`Configurar #${channel.name}`} onClose={onClose} width={480}>
      {!isOwner && <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>Você não é o dono — as opções serão recusadas pelo motor.</div>}
      <Field label="Slowmode (segundos entre mensagens)" hint="0 = desativado. Moderadores são isentos.">
        <select value={slow} onChange={e => setSlow(Number(e.target.value))} style={inputStyle}>
          {[0, 3, 5, 10, 30, 60, 300, 1800, 3600].map(s => <option key={s} value={s}>{s === 0 ? 'desativado' : `${s}s`}</option>)}
        </select>
      </Field>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: T.text, marginBottom: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={nsfw} onChange={e => setNsfw(e.target.checked)} /> Canal NSFW
      </label>
      <button onClick={async () => {
        try { await services.channelCfgSet(communityId, channel.id, slow, nsfw); onToast('canal atualizado') } catch (e: any) { onToast(String(e?.message ?? e)) }
      }} style={btnPrimary}>Salvar canal</button>

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
        <div style={pickerHead}>Emojis do servidor</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <input value={emojiChar} onChange={e => setEmojiChar(e.target.value)} placeholder="😀" style={{ ...inputStyle, width: 70 }} maxLength={4} />
          <input value={emojiName} onChange={e => setEmojiName(e.target.value)} placeholder="nome" style={{ ...inputStyle, flex: 1 }} maxLength={32} />
          <button onClick={async () => {
            if (!emojiName.trim() || !emojiChar.trim()) return
            try {
              await services.emojiUpsert({ id: `em-${Date.now().toString(36)}`, community_id: communityId, name: emojiName.trim(), char: emojiChar.trim(), created_at: Date.now() })
              setEmojiName(''); setEmojiChar('')
              services.emojiList(communityId).then(setEmojis)
            } catch (e: any) { onToast(String(e?.message ?? e)) }
          }} style={{ ...btnPrimary, padding: '8px 12px', fontSize: 12 }}>Adicionar</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {emojis.map(e => (
            <span key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 4, background: T.input, borderRadius: 6, padding: '3px 7px', fontSize: 11 }}>
              <span style={{ fontSize: 15 }}>{e.char}</span>
              <span style={{ color: T.muted }}>:{e.name}:</span>
              <button onClick={async () => { await services.emojiDelete(communityId, e.id); services.emojiList(communityId).then(setEmojis) }}
                style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 12 }}>×</button>
            </span>
          ))}
        </div>
      </div>
    </Modal>
  )
}

