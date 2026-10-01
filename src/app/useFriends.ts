// Hook de amigos — extrai lógica de friend requests do ThemeShell/MobileShell.

import { useState, useCallback, useEffect } from 'react'
import { services } from '../services'
import type { FriendView } from '../services/models'

interface UseFriendsReturn {
  friendRequests: FriendView[]
  friendsAccepted: FriendView[]
  pendingOut: FriendView[]
  refreshFriends: () => Promise<void>
  addFriend: (fp: string) => Promise<{ success?: string; error?: string }>
  respondFriend: (fp: string, accept: boolean) => Promise<void>
  removeFriend: (fp: string) => Promise<void>
}

export function useFriends(): UseFriendsReturn {
  const [friendRequests, setFriendRequests] = useState<FriendView[]>([])
  const [friendsAccepted, setFriendsAccepted] = useState<FriendView[]>([])
  const [pendingOut, setPendingOut] = useState<FriendView[]>([])

  const refreshFriends = useCallback(async () => {
    try {
      const [inReq, acc, outReq] = await Promise.all([
        services.friendsList('pending_in').catch(() => [] as FriendView[]),
        services.friendsList('accepted').catch(() => [] as FriendView[]),
        services.friendsList('pending_out').catch(() => [] as FriendView[]),
      ])
      setFriendRequests(inReq ?? [])
      setFriendsAccepted(acc ?? [])
      setPendingOut(outReq ?? [])
    } catch {
      // engine ainda não iniciou
    }
  }, [])

  const addFriend = useCallback(async (fp: string) => {
    if (!fp.trim()) return { error: 'fingerprint vazio' }
    try {
      const res = await services.friendRequest(fp.trim())
      if (res === 'queued_offline') {
        return { success: 'Peer offline — solicitação enfileirada e será enviada ao reconectar.' }
      }
      return { success: 'Solicitação enviada! Aguardando aceitação.' }
    } catch (e: any) {
      return { error: String(e?.message ?? e) }
    }
  }, [])

  const respondFriend = useCallback(async (fp: string, accept: boolean) => {
    await services.friendRespond(fp, accept)
    await refreshFriends()
  }, [refreshFriends])

  const removeFriend = useCallback(async (fp: string) => {
    await services.friendRemove(fp)
    await refreshFriends()
  }, [refreshFriends])

  // Ao vivo: carrega no mount e reinscreve nos eventos de amizade
  // (antes só atualizava via chamada manual — aceite só aparecia após restart).
  useEffect(() => {
    refreshFriends()
  }, [refreshFriends])

  useEffect(() => {
    return services.subscribe((ev) => {
      if (ev.type === 'friend_request_in' || ev.type === 'friend_accepted' || ev.type === 'friend_removed') {
        refreshFriends()
      }
    })
  }, [refreshFriends])

  return { friendRequests, friendsAccepted, pendingOut, refreshFriends, addFriend, respondFriend, removeFriend }
}
