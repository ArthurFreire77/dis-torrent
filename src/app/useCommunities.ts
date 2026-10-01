// Hook de comunidades — extrai lógica de servidores do ThemeShell/MobileShell.

import { useState, useCallback, useEffect } from 'react'
import { services } from '../services'
import type { CommunityView, ChannelMeta, RoleView, BotView } from '../services/models'

interface UseCommunitiesReturn {
  communities: CommunityView[]
  refreshCommunities: () => Promise<void>
  createCommunity: (name: string, channels: string[]) => Promise<string>
  joinCommunity: (token: string) => Promise<string>
  makeInvite: (communityId: string, memberFp: string) => Promise<string>
  extraChannels: ChannelMeta[]
  roles: RoleView[]
  bots: BotView[]
  refreshExtras: (cid: string | null) => Promise<void>
}

export function useCommunities(): UseCommunitiesReturn {
  const [communities, setCommunities] = useState<CommunityView[]>([])
  const [extraChannels, setExtraChannels] = useState<ChannelMeta[]>([])
  const [roles, setRoles] = useState<RoleView[]>([])
  const [bots, setBots] = useState<BotView[]>([])

  const refreshCommunities = useCallback(async () => {
    try {
      const list = await services.communitiesList() ?? []
      setCommunities(list)
    } catch {
      // engine indisponível
    }
  }, [])

  const refreshExtras = useCallback(async (cid: string | null) => {
    if (!cid) {
      setExtraChannels([])
      setRoles([])
      setBots([])
      return
    }
    try {
      const [chs, rs, bs] = await Promise.all([
        services.channelList(cid).catch(() => [] as ChannelMeta[]),
        services.rolesList(cid).catch(() => [] as RoleView[]),
        services.botsList(cid).catch(() => [] as BotView[]),
      ])
      setExtraChannels(chs ?? [])
      setRoles(rs ?? [])
      setBots(bs ?? [])
    } catch {
      // sem dados
    }
  }, [])

  const createCommunity = useCallback(async (name: string, channels: string[]) => {
    return await services.createCommunity(name, channels)
  }, [])

  const joinCommunity = useCallback(async (token: string) => {
    return await services.joinCommunity(token)
  }, [])

  const makeInvite = useCallback(async (communityId: string, memberFp: string) => {
    return await services.makeInvite(communityId, memberFp)
  }, [])

  // Ao vivo: carrega no mount e reinscreve nos eventos de comunidade/grupo
  // (antes só atualizava via chamada manual — grupo/servidor só aparecia após restart).
  useEffect(() => {
    refreshCommunities()
  }, [refreshCommunities])

  useEffect(() => {
    return services.subscribe((ev) => {
      if (
        ev.type === 'community_joined' ||
        ev.type === 'community_removed' ||
        ev.type === 'group_synced' ||
        ev.type === 'channel_created' ||
        ev.type === 'channel_deleted'
      ) {
        refreshCommunities()
      }
    })
  }, [refreshCommunities])

  return {
    communities,
    refreshCommunities,
    createCommunity,
    joinCommunity,
    makeInvite,
    extraChannels,
    roles,
    bots,
    refreshExtras,
  }
}
