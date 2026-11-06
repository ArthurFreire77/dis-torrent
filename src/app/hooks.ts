import { useCallback, useEffect, useRef, useState } from 'react'
import { services } from '../services'
import type {
  Conversation,
  EngineEvent,
  Identity,
  NetworkStatusView,
  PeerView,
  StoredMessage,
} from '../services/models'

export function useIdentity() {
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    services
      .identityGet()
      .then((id) => alive && setIdentity(id))
      .catch(() => {})
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const create = useCallback(async (nickname: string, password?: string | null) => {
    const id = await services.identityCreate(nickname, password ?? null)
    setIdentity(id)
    return id
  }, [])

  const rename = useCallback(async (nickname: string) => {
    const id = await services.identityRename(nickname)
    setIdentity(id)
    return id
  }, [])

  return { identity, loading, create, rename, setIdentity }
}

export function useNetwork(pollMs = 30000) {
  const [status, setStatus] = useState<NetworkStatusView | null>(null)
  const [peers, setPeers] = useState<PeerView[]>([])

  const refresh = useCallback(async (opts?: { force?: boolean }) => {
    const oculto = typeof document !== 'undefined' && document.hidden
    if (oculto && !opts?.force) return
    try {
      const [s, p] = await Promise.all([services.networkStatus(), services.peersList()])
      setStatus(s)
      setPeers(p)
    } catch {
      setStatus({ state: 'DISCONNECTED', online_peers: 0, listen_port: 0 })
      setPeers([])
    }
  }, [])

  useEffect(() => {
    let alive = true
    const safe = () => alive && refresh()
    safe()
    if (pollMs <= 0) return () => { alive = false }
    const t = setInterval(safe, pollMs)
    const onVis = () => { if (!document.hidden) void refresh({ force: true }) }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      clearInterval(t)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
    }
  }, [refresh, pollMs])

  useEffect(() => services.subscribe((ev) => {
    if (ev.type === 'state_changed' || ev.type === 'peer_online' || ev.type === 'peer_offline' || ev.type === 'peer_discovered') {
      void refresh({ force: true })
    }
  }), [refresh])

  return { status, peers, refresh }
}

export function useEngineEvents(onEvent: (ev: EngineEvent) => void) {
  const cbRef = useRef(onEvent)
  cbRef.current = onEvent
  useEffect(() => services.subscribe((ev) => cbRef.current(ev)), [])
}

export function useConversations(open: boolean) {
  const [conversations, setConversations] = useState<Conversation[]>([])

  const refresh = useCallback(async () => {
    try {
      // Visão com contadores: prévia, horário e não lidas por membro. O
      // `conversationsList` continua existindo para quem só quer os metadados.
      const list = await services.conversationsOverview()
      setConversations((prev) => {
        if (
          prev.length === list.length &&
          prev.every((c, i) => {
            const n = list[i]
            return (
              c.id === n?.id &&
              c.title === n?.title &&
              (c as Conversation & { unread_count?: number }).unread_count === n?.unread_count &&
              (c as Conversation & { last_ts?: number }).last_ts === n?.last_ts &&
              (c as Conversation & { last_body?: string }).last_body === n?.last_body
            )
          })
        ) {
          return prev
        }
        return list
      })
    } catch {
      setConversations([])
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let alive = true
    refresh()
    let t: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (!alive || t) return
      t = setTimeout(() => { t = null; if (alive) refresh() }, 300)
    }
    const un = services.subscribe((ev) => {
      if (
        ev.type === 'message_new' ||
        ev.type === 'group_synced' ||
        ev.type === 'community_joined' ||
        ev.type === 'community_removed' ||
        ev.type === 'friend_accepted' ||
        ev.type === 'friend_removed'
      ) {
        schedule()
      }
    })
    return () => { alive = false; if (t) clearTimeout(t); un() }
  }, [open, refresh])

  return { conversations, refresh }
}

export const MESSAGES_PAGE = 100

export function useMessages(convId: string | null) {
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const seq = useRef(0)
  const loadingOlder = useRef(false)
  const messagesRef = useRef<StoredMessage[]>([])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const refresh = useCallback(async () => {
    if (!convId) {
      setMessages([])
      setHasOlder(false)
      return
    }
    const my = ++seq.current
    try {
      const over = await services.messagesWindow(convId, null, MESSAGES_PAGE + 1)
      if (seq.current === my) {
        setMessages(over.slice(0, MESSAGES_PAGE))
        setHasOlder(over.length > MESSAGES_PAGE)
      }
    } catch {
      if (seq.current === my) {
        setMessages([])
        setHasOlder(false)
      }
    }
  }, [convId])

  const loadOlder = useCallback(async () => {
    if (!convId || loadingOlder.current) return
    loadingOlder.current = true
    const my = ++seq.current
    try {
      // Seção 1: oldest
      let oldest: number | null = null
      for (const m of messagesRef.current) {
        if (m.id.startsWith('pending-')) continue
        if (oldest === null || m.ts < oldest) oldest = m.ts
      }
      if (oldest === null) {
        if (seq.current === my) setHasOlder(false)
        return
      }
      const over = await services.messagesWindow(convId, oldest, MESSAGES_PAGE + 1)
      if (seq.current !== my) return
      const page = over.slice(0, MESSAGES_PAGE)
      if (page.length === 0) {
        setHasOlder(false)
        return
      }
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id))
        const fresh = page.filter((m) => !known.has(m.id))
        if (fresh.length === 0) return prev
        return [...fresh, ...prev].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
      })
      setHasOlder(over.length > MESSAGES_PAGE)
    } catch {} finally {
      loadingOlder.current = false
    }
  }, [convId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const patchStatus = useCallback((msgId: string, status: StoredMessage['status']) => {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, status } : m)))
  }, [])

  const append = useCallback((m: StoredMessage) => {
    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
  }, [])

  const replaceOptimistic = useCallback((tempId: string, definitive: StoredMessage) => {
    setMessages((prev) => {
      if (prev.some((x) => x.id === definitive.id)) {
        return prev.filter((x) => x.id !== tempId)
      }
      if (prev.some((x) => x.id === tempId)) {
        return prev.map((x) => (x.id === tempId ? definitive : x))
      }
      let bestIdx = -1
      let bestDiff = Infinity
      prev.forEach((x, i) => {
        if (x.id.startsWith('pending-') && x.body === definitive.body && x.direction === 'out') {
          const diff = Math.abs((x.ts ?? 0) - definitive.ts)
          if (diff < 10000 && diff < bestDiff) { bestDiff = diff; bestIdx = i }
        }
      })
      if (bestIdx >= 0) {
        const next = [...prev]
        next[bestIdx] = definitive
        return next
      }
      return [...prev, definitive]
    })
  }, [])

  const failOptimistic = useCallback((tempId: string) => {
    setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, status: 'failed' as const } : m)))
  }, [])

  const convRef = useRef(convId)
  convRef.current = convId
  const appendRef = useRef(append)
  appendRef.current = append
  const patchRef = useRef(patchStatus)
  patchRef.current = patchStatus
  useEffect(() => {
    if (!convId) return
    return services.subscribe((ev) => {
      if (ev.type === 'message_new' && (ev as StoredMessage & { conv_id: string }).conv_id === convRef.current) {
        appendRef.current(ev as StoredMessage)
      } else if (ev.type === 'message_status') {
        patchRef.current(ev.msg_id, ev.status)
      }
    })
  }, [convId])

  return { messages, refresh, patchStatus, append, replaceOptimistic, failOptimistic, loadOlder, hasOlder }
}
