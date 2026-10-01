// Hook da camada social (paridade Discord) — liga a UI aos serviços REAIS.
//
// Uma única chamada em LOTE por janela de mensagens (`reactionsBulk` +
// `metaBulk`) em vez de N chamadas por mensagem: é o que permite uma conversa
// longa abrir sem "flash" de estado. Tudo que o usuário age (reagir, editar,
// apagar, fixar, responder) vai pelo motor, que valida permissão e difunde
// pelo túnel — a UI nunca decide nada.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { services } from '../services'
import type {
  EmojiView,
  MsgMetaView,
  PresenceStatus,
  PresenceView,
  ReactionSummary,
  StoredMessage,
} from '../services/models'

export interface SocialWindow {
  /** msg_id → reações agregadas (contagem + se é minha) */
  reactions: Map<string, ReactionSummary[]>
  /** msg_id → metadados (editado/apagado/fixado/respondendo/encaminhada) */
  meta: Map<string, MsgMetaView>
  /** corpo efetivo por msg_id (edição aplicada) */
  bodies: Map<string, string>
  loading: boolean
  error: string | null
  reload: () => void
  /** recarrega só as reactions/meta de uma janela (após uma ação) */
  refreshIds: (ids: string[]) => void
}

/**
 * Carrega reações + metadados + corpos efetivos da janela atual.
 * Só re-consulta quando o CONJUNTO de ids muda (não a cada tecla do composer).
 */
export function useSocialWindow(messages: StoredMessage[], convId: string | null): SocialWindow {
  const [reactions, setReactions] = useState<Map<string, ReactionSummary[]>>(new Map())
  const [meta, setMeta] = useState<Map<string, MsgMetaView>>(new Map())
  const [bodies, setBodies] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const seq = useRef(0)

  const ids = useMemo(() => messages.map((m) => m.id), [messages])
  const idsKey = useMemo(() => ids.join('|'), [ids])

  useEffect(() => {
    if (!convId || ids.length === 0) {
      setReactions(new Map()); setMeta(new Map()); setBodies(new Map())
      return
    }
    const my = ++seq.current
    setLoading(true)
    setError(null)
    const real = ids.slice(0, 300)
    Promise.all([
      services.reactionsBulk(real).catch(() => [] as ReactionSummary[]),
      services.metaBulk(real).catch(() => [] as MsgMetaView[]),
      services.effectiveBodies(real).catch(() => [] as [string, string][]),
    ])
      .then(([rx, mt, bd]) => {
        if (seq.current !== my) return
        const rmap = new Map<string, ReactionSummary[]>()
        for (const r of rx) {
          const arr = rmap.get(r.msg_id) ?? []
          arr.push(r)
          rmap.set(r.msg_id, arr)
        }
        for (const arr of rmap.values()) arr.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji))
        setReactions(rmap)
        setMeta(new Map(mt.map((m) => [m.msg_id, m])))
        setBodies(new Map(bd))
      })
      .catch((e) => { if (seq.current === my) setError(String((e as Error)?.message ?? e)) })
      .finally(() => { if (seq.current === my) setLoading(false) })
  }, [convId, idsKey, nonce])

  const refreshIds = useCallback((list: string[]) => {
    if (list.length === 0) return
    const unique = Array.from(new Set(list)).slice(0, 300)
    void (async () => {
      try {
        const [rx, mt, bd] = await Promise.all([
          services.reactionsBulk(unique),
          services.metaBulk(unique),
          services.effectiveBodies(unique),
        ])
        // Substitui a lista INTEIRA de cada id pedido — mesclar só acrescentaria
        // e uma reação removida nunca sairia da tela (bug: toggle-off invisível).
        const fresh = new Set<string>()
        setReactions((prev) => {
          const next = new Map(prev)
          for (const r of rx) {
            const arr = next.get(r.msg_id) ?? []
            if (!fresh.has(r.msg_id)) { arr.length = 0; fresh.add(r.msg_id) }
            arr.push(r)
            next.set(r.msg_id, arr)
          }
          // ids pedidos que NÃO voltaram = ficaram sem nenhuma reação
          for (const id of unique) if (!fresh.has(id)) next.set(id, [])
          return next
        })
        setMeta((prev) => {
          const next = new Map(prev)
          for (const m of mt) next.set(m.msg_id, m)
          return next
        })
        setBodies((prev) => {
          const next = new Map(prev)
          for (const [k, v] of bd) next.set(k, v)
          return next
        })
      } catch { /* mantém o que há — o próximo refresh corrige */ }
    })()
  }, [])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // Reação do OUTRO lado chegando (mobile usa este hook em vez do
  // MessageList): sem esta escuta a reação remota só aparecia ao reabrir a
  // conversa. Re-lê só a mensagem afetada via refreshIds.
  useEffect(() => {
    if (!convId) return
    const un = services.subscribe((ev: any) => {
      try {
        if (ev?.type !== 'reaction_changed' || ev?.conv_id !== convId) return
        const mid = String(ev?.msg_id ?? '')
        if (!mid) return
        refreshIds([mid])
      } catch { /* evento nunca derruba o hook */ }
    })
    return () => { try { (un as unknown as () => void)() } catch { /* ignore */ } }
  }, [convId, refreshIds])

  return { reactions, meta, bodies, loading, error, reload, refreshIds }
}

/** Ações de mensagem delegadas ao motor (todas autenticadas e auditáveis). */
export function useMessageActions(onChanged?: (ids: string[]) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (ids: string[], fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged?.(ids)
      return true
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      return false
    } finally {
      setBusy(false)
    }
  }, [onChanged])

  return useMemo(() => ({
    busy, error, setError,
    toggleReaction: (convId: string, msgId: string, emoji: string) => run([msgId], () => services.react(convId, msgId, emoji)),
    edit: (convId: string, msgId: string, body: string) => run([msgId], () => services.editMessage(convId, msgId, body)),
    remove: (convId: string, msgId: string) => run([msgId], () => services.deleteMessage(convId, msgId)),
    setPinned: (convId: string, msgId: string, pinned: boolean) => run([msgId], () => services.pin(convId, msgId, pinned)),
    linkReply: (convId: string, msgId: string, replyTo: string) => run([msgId], () => services.reply(convId, msgId, replyTo)),
    forward: (srcMsgId: string, conv: string, channel: string, label: string) => run([srcMsgId], () => services.forward(srcMsgId, conv, channel, label)),
    report: (fp: string, communityId?: string, reason?: string) => run([], () => services.reportUser(fp, communityId, reason)),
  }), [run, busy, error])
}

/** Presença de todos os peers conhecidos (online/idle/dnd/invisible/offline). */
export function usePresence() {
  const [map, setMap] = useState<Map<string, PresenceView>>(new Map())
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    const load = () => {
      services.presenceList()
        .then((list) => { if (alive) setMap(new Map((list ?? []).map((p) => [p.fp, p]))) })
        .catch(() => { if (alive) setMap(new Map()) })
    }
    load()
    const t = setInterval(load, 6000)
    const un = services.subscribe((ev) => {
      if (ev.type === 'presence_changed') {
        setMap((prev) => {
          const next = new Map(prev)
          next.set(ev.fp, { fp: ev.fp, status: ev.status as PresenceStatus, custom: ev.custom, custom_emoji: ev.custom_emoji, updated_at: Date.now() })
          return next
        })
      } else if (ev.type === 'peer_offline') {
        setMap((prev) => {
          const next = new Map(prev)
          const cur = next.get(ev.fp)
          if (cur) next.set(ev.fp, { ...cur, status: 'offline' })
          return next
        })
      }
    })
    return () => { alive = false; clearInterval(t); un() }
  }, [nonce])
  return { presence: map, reload: () => setNonce((n) => n + 1) }
}

export const PRESENCE_COLOR: Record<PresenceStatus, string> = {
  online: '#23a559', idle: '#f0b232', dnd: '#f23f42', invisible: '#80848e', offline: '#80848e',
}

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  online: 'Online', idle: 'Ausente', dnd: 'Não perturbe', invisible: 'Invisível', offline: 'Offline',
}

/** Emojis customizados de um servidor (`:name:` no chat). */
export function useServerEmojis(communityId: string | null) {
  const [emojis, setEmojis] = useState<EmojiView[]>([])
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!communityId) { setEmojis([]); return }
    let alive = true
    services.emojiList(communityId)
      .then((l) => { if (alive) setEmojis(l ?? []) })
      .catch(() => { if (alive) setEmojis([]) })
    return () => { alive = false }
  }, [communityId, nonce])
  return { emojis, reload: () => setNonce((n) => n + 1) }
}

/**
 * Cursor de leitura: marca a conversa como lida até `ts` e expõe o total de
 * não-lidas (badge no rail) + a marca de "novas mensagens" no chat.
 */
export function useReadState(convId: string | null, myFp: string | null) {
  const [unread, setUnread] = useState(0)
  const [mentions, setMentions] = useState(0)
  const [lastRead, setLastRead] = useState(0)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => {
    let alive = true
    const load = () => {
      void services.unreadMentions().then((n) => { if (alive) setMentions(Number(n) || 0) }).catch(() => {})
      if (!convId) { setUnread(0); return }
      void Promise.all([
        services.unreadCount(convId).catch(() => 0),
        services.readAll().catch(() => []),
      ]).then(([u, cursors]) => {
        if (!alive) return
        setUnread(Number(u) || 0)
        setLastRead(Number(cursors?.find((c) => c.conv_id === convId)?.last_read_ts ?? 0) || 0)
      })
    }
    load()
    const t = setInterval(load, 5000)
    const un = services.subscribe((ev) => {
      if (ev.type === 'message_new' || ev.type === 'message_deleted') load()
    })
    return () => { alive = false; clearInterval(t); un() }
  }, [convId])

  useEffect(() => reload(), [reload, nonce])

  const markRead = useCallback((ts: number) => {
    if (!convId || ts <= 0) return
    void services.readSet(convId, ts).then(() => {
      setUnread(0)
      setLastRead(ts)
    }).catch(() => {})
  }, [convId])

  return { unread, mentions, lastRead, markRead, reload: () => setNonce((n) => n + 1), myFp }
}
