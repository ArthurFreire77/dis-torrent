// Gestão de membros do servidor.
//
// Antes: cada membro era uma linha com dois `<select>` de rótulo "+ Cargo" e
// "- Cargo" (a mesma coisa em dois controles), os cargos apareciam como chips
// com um "✕" de texto dentro, e a expulsão usava `window.confirm`.
//
// Agora: busca, filtro por cargo, atribuição por um único controle com
// descriptive, chips com botão de remover de verdade, e confirmação própria
// para expulsar.

import { useMemo, useState } from 'react'
import type { RoleView } from '../../services/models'
import { Ic } from '../../shared/icons'
import { Tooltip } from '../../shared/Tooltip'
import {
  Button,
  EmptyState,
  IconButton,
  Modal,
  Notice,
  ui,
} from '../../shared/ui'

export function MemberManager({
  members,
  roles,
  memberRoles,
  ownerFp,
  myFp,
  onAssign,
  onUnassign,
  onKick,
}: {
  members: [string, string, string][]
  roles: RoleView[]
  memberRoles: Record<string, string[]>
  ownerFp: string
  myFp: string | undefined
  onAssign: (fp: string, roleId: string) => Promise<void>
  onUnassign: (fp: string, roleId: string) => Promise<void>
  onKick: (fp: string) => Promise<void>
}) {
  const [busca, setBusca] = useState('')
  const [filtroCargo, setFiltroCargo] = useState('')
  const [paraExpulsar, setParaExpulsar] = useState<[string, string] | null>(null)
  const [ocupado, setOcupado] = useState(false)

  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase()
    return members.filter(([fp, nick]) => {
      if (filtroCargo && !(memberRoles[fp] ?? []).includes(filtroCargo)) return false
      if (!termo) return true
      return nick.toLowerCase().includes(termo) || fp.toLowerCase().includes(termo)
    })
  }, [members, busca, filtroCargo, memberRoles])

  return (
    <div style={{ maxWidth: 860 }}>
      <Notice tone="info" icon="info">
        Dar um cargo é a forma de permitir ou negar o que alguém pode fazer. Ninguém
        precisa de permissão editada individualmente.
      </Notice>

      {members.length === 0 ? (
        <div style={{ marginTop: ui.xl }}>
          <EmptyState
            icon="users"
            title="Ninguém mais neste servidor"
            hint="Gere um link de convite na aba Convites para trazer outras pessoas."
          />
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              gap: ui.sm,
              marginTop: ui.xl,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 0 }}>
              <span
                style={{
                  position: 'absolute',
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: ui.muted,
                  display: 'inline-flex',
                  pointerEvents: 'none',
                }}
              >
                <Ic name="search" size={15} />
              </span>
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por nome ou impressão digital"
                aria-label="Buscar membro"
                style={{
                  width: '100%',
                  background: ui.input,
                  border: `1px solid ${ui.border}`,
                  borderRadius: ui.radius,
                  padding: '10px 12px 10px 32px',
                  color: ui.text,
                  fontSize: 13,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <select
              value={filtroCargo}
              onChange={(e) => setFiltroCargo(e.target.value)}
              aria-label="Filtrar por cargo"
              style={{
                background: ui.input,
                color: ui.text,
                border: `1px solid ${ui.border}`,
                borderRadius: ui.radius,
                padding: '10px 12px',
                fontSize: 13,
              }}
            >
              <option value="">Todos os cargos</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>

            <span style={{ fontSize: 12, color: ui.muted, whiteSpace: 'nowrap' }}>
              {filtrados.length} de {members.length}
            </span>
          </div>

          {filtrados.length === 0 ? (
            <div style={{ marginTop: ui.xl }}>
              <EmptyState
                icon="search"
                title="Ninguém encontrado"
                hint="Ajuste a busca ou o filtro de cargo para ver outros membros."
              />
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                marginTop: ui.md,
              }}
            >
              {filtrados.map(([fp, nick, papel]) => {
                const meus = memberRoles[fp] ?? []
                const atribuidos = roles.filter((r) => meus.includes(r.id))
                const disponiveis = roles.filter((r) => !meus.includes(r.id))
                const ehDono = papel === 'owner'
                const souEu = fp === myFp

                return (
                  <div
                    key={fp}
                    style={{
                      display: 'flex',
                      gap: 11,
                      alignItems: 'flex-start',
                      background: ui.surface,
                      border: `1px solid ${ui.border}`,
                      borderRadius: ui.radius,
                      padding: '12px 14px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: '50%',
                        background: corDe(fp),
                        color: '#fff',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 800,
                        fontSize: 15,
                        flexShrink: 0,
                      }}
                    >
                      {(nick || fp).charAt(0).toUpperCase()}
                    </span>

                    <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 700, color: ui.heading }}>
                          {nick || fp.slice(0, 12)}
                        </span>
                        {ehDono && (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 800,
                              background: ui.accent,
                              color: '#fff',
                              padding: '2px 6px',
                              borderRadius: 4,
                            }}
                          >
                            DONO
                          </span>
                        )}
                        {souEu && (
                          <span style={{ fontSize: 11, color: ui.muted }}>(você)</span>
                        )}
                      </div>
                      <code
                        style={{
                          display: 'block',
                          fontSize: 11,
                          color: ui.muted,
                          fontFamily: 'JetBrains Mono, monospace',
                          marginTop: 3,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {fp}
                      </code>

                      <div
                        style={{
                          display: 'flex',
                          gap: 5,
                          marginTop: 9,
                          flexWrap: 'wrap',
                        }}
                      >
                        {atribuidos.map((r) => (
                          <span
                            key={r.id}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 5,
                              fontSize: 11,
                              background: `${r.color}22`,
                              color: r.color,
                              border: `1px solid ${r.color}55`,
                              padding: '3px 5px 3px 9px',
                              borderRadius: 99,
                              fontWeight: 700,
                            }}
                          >
                            {r.name}
                            <button
                              type="button"
                              onClick={() => onUnassign(fp, r.id)}
                              aria-label={`Remover cargo ${r.name} de ${nick || fp}`}
                              title={`Remover ${r.name}`}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'inherit',
                                cursor: 'pointer',
                                padding: 0,
                                display: 'inline-flex',
                                opacity: 0.7,
                              }}
                            >
                              <Ic name="x" size={11} />
                            </button>
                          </span>
                        ))}
                        {atribuidos.length === 0 && (
                          <span style={{ fontSize: 11, color: ui.muted, opacity: 0.75 }}>
                            sem cargos
                          </span>
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        gap: 6,
                        alignItems: 'center',
                        flexShrink: 0,
                        flexWrap: 'wrap',
                      }}
                    >
                      {disponiveis.length > 0 ? (
                        <select
                          value=""
                          onChange={(e) => {
                            const rid = e.target.value
                            if (rid) onAssign(fp, rid)
                          }}
                          aria-label={`Dar um cargo a ${nick || fp}`}
                          style={{
                            background: ui.input,
                            color: ui.text,
                            border: `1px solid ${ui.border}`,
                            borderRadius: ui.radiusSm,
                            padding: '7px 9px',
                            fontSize: 12,
                            maxWidth: 150,
                          }}
                        >
                          <option value="">+ Dar cargo</option>
                          {disponiveis.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span style={{ fontSize: 11, color: ui.muted }}>todos os cargos dados</span>
                      )}

                      {fp !== ownerFp && (
                        <Tooltip label={`Expulsar ${nick || fp}`}>
                          <IconButton
                            icon="x"
                            label={`Expulsar ${nick || fp}`}
                            onClick={() => setParaExpulsar([fp, nick])}
                            size={30}
                          />
                        </Tooltip>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      <Modal
        open={paraExpulsar !== null}
        onClose={() => setParaExpulsar(null)}
        title="Expulsar membro?"
        subtitle={paraExpulsar ? `${paraExpulsar[1] || paraExpulsar[0].slice(0, 12)} sai do servidor` : undefined}
        width={480}
        footer={
          <>
            <span style={{ flex: 1 }} />
            <Button onClick={() => setParaExpulsar(null)} disabled={ocupado}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              icon="ban"
              busy={ocupado}
              onClick={async () => {
                if (!paraExpulsar) return
                setOcupado(true)
                try {
                  await onKick(paraExpulsar[0])
                  setParaExpulsar(null)
                } finally {
                  setOcupado(false)
                }
              }}
            >
              Expulsar
            </Button>
          </>
        }
      >
        <Notice tone="warning" icon="warn">
          A pessoa perde acesso a todos os canais deste servidor. Ela pode entrar de novo se
          outro convite for gerado. As mensagens que ela enviou continuam aqui.
        </Notice>
      </Modal>
    </div>
  )
}

/** Cor estável derivada do fingerprint — mesma pessoa, mesma cor, sempre. */
function corDe(fp: string): string {
  const paleta = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#00a8fc']
  let h = 0
  for (let i = 0; i < fp.length; i++) h = (h * 31 + fp.charCodeAt(i)) >>> 0
  return paleta[h % paleta.length]
}