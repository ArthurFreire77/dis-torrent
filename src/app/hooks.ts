// Hooks que ligam a UI FORGE aos services reais. Nenhum dado fictício aqui.

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

export function useNetwork(pollMs = 4000) {
  const [status, setStatus] = useState<NetworkStatusView | null>(null)
  const [peers, setPeers] = useState<PeerView[]>([])

  const refresh = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      const [s, p] = await Promise.all([services.networkStatus(), services.peersList()])
      setStatus(s)
      setPeers(p)
    } catch {
      // sem engine (sem identidade) — estado real: offline
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
    return () => { alive = false; clearInterval(t) }
  }, [refresh, pollMs])

  // Push-only: atualiza na hora via eventos, sem esperar o poll (0 delay percebido).
  useEffect(() => services.subscribe((ev) => {
    if (ev.type === 'state_changed' || ev.type === 'peer_online' || ev.type === 'peer_offline' || ev.type === 'peer_discovered') {
      refresh()
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
      const list = await services.conversationsList()
      setConversations((prev) => {
        // evita re-render se nada mudou (0 delay no composer)
        if (prev.length === list.length && prev.every((c, i) => c.id === list[i]?.id && c.title === list[i]?.title)) return prev
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
    // coalesce: eventos em rajada viram 1 refresh
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

  // Ao vivo: conversa nova atualiza a lista SEM restart (coalescido).
  return { conversations, refresh }
}

/** Tamanho da página de mensagens (janela por ts — 5.4). */
export const MESSAGES_PAGE = 100

export function useMessages(convId: string | null) {
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const seq = useRef(0)
  const loadingOlder = useRef(false)
  // espelho síncrono para o cursor de paginação (refs não esperam render)
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
      // janela: só as mais recentes — conversa grande não trava a UI.
      // Pede PAGE+1 para saber se há mais sem mentir no "carregar mais".
      const over = await services.messagesWindow(convId, null, MESSAGES_PAGE + 1)
      // guarda race: resposta lenta de conversa antiga não sobrescreve a atual
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

  // Carrega a página anterior (mensagens mais antigas) e prefixa sem duplicar.
  const loadOlder = useCallback(async () => {
    if (!convId || loadingOlder.current) return
    loadingOlder.current = true
    const my = ++seq.current
    try {
      // ts mínimo das mensagens reais (ignora ecos otimistas pending-*)
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
    } catch {
      // mantém o que há; o usuário tenta de novo
    } finally {
      loadingOlder.current = false
    }
  }, [convId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // patchStatus cobre mensagens otimistas: apos replaceOptimistic o id definitivo
  // esta na lista, entao message_status delivered (msg_id definitivo) atualiza o ✓✓.
  const patchStatus = useCallback((msgId: string, status: StoredMessage['status']) => {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, status } : m)))
  }, [])

  const append = useCallback((m: StoredMessage) => {
    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
  }, [])

  // T1 eco otimista: substitui o pending-<ts> pelo definitivo.
  // - Caso comum: troca por tempId (closure do send).
  // - Caso corrida (message_new ja anexou o definitivo via subscribe): remove o temp.
  // - Fallback: match por body+ts proximo (mesmo body, ts dentro de 10s).
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

  // Ao vivo: mensagem da conversa aberta entra sem reload; status atualiza junto.
  // (append/patchStatus dedupam por id — seguro com os handlers dos shells.)
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
