// Permissões de cargo, agrupadas por categoria.
//
// Por que agrupar: `PERM_LABELS` é um objeto plano de 10 entradas. Renderizado
// como lista de checkbox, virava uma coluna de 10 caixas iguais em que o
// usuário precisa ler TODAS para achar "Gerenciar cargos". Agrupado por
// categoria e com um único interruptor por grupo, o que importa fica visível
// e o resto fica a um clique.
//
// O interruptor de grupo é ternário, nunca binário: "marcar tudo" e "desmarcar
// tudo" e "alguns" são três estados diferentes, e um checkbox que fica
// marcado quando só 1 de 10 está marcado mente para o usuário.

import { useMemo, useState } from 'react'
import { PERMS, PERM_LABELS } from '../../services/models'
import { Ic } from '../../shared/icons'
import { ui } from '../../shared/ui'
import type { IconName } from '../../shared/icons'

export interface PermGroup {
  key: string
  label: string
  icon: IconName
  /** O que estas permissões controla, em uma frase. Didático de propósito. */
  description: string
  perms: { bit: number; label: string; hint?: string }[]
}

export const PERM_GROUPS: PermGroup[] = [
  {
    key: 'server',
    label: 'Administração do servidor',
    icon: 'settings',
    description: 'Ações que mudam o servidor como um todo. Dê com cuidado.',
    perms: [
      { bit: PERMS.ADMINISTRATOR, label: 'Administrador', hint: 'Vale TODAS as permissões abaixo e não pode ser removido por outros cargos.' },
      { bit: PERMS.MANAGE_CHANNELS, label: 'Gerenciar canais', hint: 'Criar, editar, mover e excluir canais e categorias.' },
      { bit: PERMS.MANAGE_ROLES, label: 'Gerenciar cargos', hint: 'Criar cargos e mudar as permissões de outras pessoas.' },
      { bit: PERMS.MANAGE_BOT, label: 'Gerenciar bots', hint: 'Criar, configurar e remover bots deste servidor.' },
    ],
  },
  {
    key: 'membros',
    label: 'Membros',
    icon: 'users',
    description: 'Quem o cargo pode tirar, silenciar ou banir.',
    perms: [
      { bit: PERMS.KICK_MEMBERS, label: 'Expulsar membros', hint: 'Remover alguém do servidor. A pessoa pode voltar com um novo convite.' },
      { bit: PERMS.BAN_MEMBERS, label: 'Banir membros', hint: 'Remover e bloquear de voltar.' },
    ],
  },
  {
    key: 'mensagens',
    label: 'Mensagens',
    icon: 'send',
    description: 'O que o cargo pode fazer dentro dos canais.',
    perms: [
      { bit: PERMS.VIEW_CHANNEL, label: 'Ver canais', hint: 'Se desligado, os canais ficam invisíveis — mesmo abertos por link.' },
      { bit: PERMS.SEND_MESSAGES, label: 'Enviar mensagens', hint: 'Poder falar no canal.' },
      { bit: PERMS.EMBED_LINKS, label: 'Enviar embeds e links', hint: 'Publica com pré-visualização e mostra links de sites.' },
      { bit: PERMS.MENTION_EVERYONE, label: 'Mencionar @everyone', hint: 'Notifica o servidor inteiro de uma vez.' },
    ],
  },
]

/** Bits de todos os grupos, para validar "cargo vazio". */
export const ALL_PERM_BITS = PERM_GROUPS.flatMap((g) => g.perms.map((p) => p.bit))

export function permsInGroup(group: PermGroup): number {
  return group.perms.reduce((acc, p) => acc | p.bit, 0)
}

/** Quantas permissões do grupo estão ligadas. */
export function groupCount(group: PermGroup, mask: number): number {
  return group.perms.filter((p) => (mask & p.bit) !== 0).length
}

export function PermissionEditor({
  value,
  onChange,
  /** Permissões obrigatórias: sempre ligadas e não clicáveis (ex.: dono). */
  locked = [],
  lockedHint,
}: {
  value: number
  onChange: (mask: number) => void
  locked?: number[]
  lockedHint?: string
}) {
  // Categorias começam abertas se têm algo marcado; senão fechadas. Assim o que
  // a pessoa configurou de fato fica visível ao abrir a tela.
  const [abertos, setAbertos] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const g of PERM_GROUPS) init[g.key] = groupCount(g, value) > 0
    return init
  })

  const isLocked = useMemo(() => {
    const s = new Set(locked)
    return (bit: number) => s.has(bit)
  }, [locked])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
      {PERM_GROUPS.map((g) => {
        const expandido = abertos[g.key] ?? false
        const marcados = groupCount(g, value)
        const total = g.perms.length
        const todos = marcados === total && total > 0
        const algum = marcados > 0
        const todosBloqueados = g.perms.every((p) => isLocked(p.bit))

        const setAberto = () =>
          setAbertos((a) => ({ ...a, [g.key]: !a[g.key] }))

        const toggleTodos = () => {
          // Nunca desliga o que está travado.
          const bitmask = permsInGroup(g)
          const next = todos ? value & ~bitmask : value | bitmask
          // re-liga os travados que o `&~` acabou de limpar
          const relock = g.perms
            .filter((p) => isLocked(p.bit))
            .reduce((acc, p) => acc | p.bit, 0)
          onChange(next | relock)
        }

        return (
          <div
            key={g.key}
            style={{
              background: ui.input,
              border: `1px solid ${ui.border}`,
              borderRadius: ui.radius,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '11px 12px',
              }}
            >
              <button
                type="button"
                onClick={setAberto}
                aria-expanded={expandido}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: ui.muted,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  padding: 0,
                }}
                aria-label={expandido ? `Recolher ${g.label}` : `Expandir ${g.label}`}
              >
                <Ic name="chevronRight" size={15} rotate={expandido ? 90 : 0} />
              </button>

              <span style={{ color: algum ? ui.accent : ui.muted, display: 'inline-flex' }}>
                <Ic name={g.icon} size={16} />
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: ui.heading }}>
                  {g.label}
                </div>
                <div style={{ fontSize: 11, color: ui.muted, marginTop: 2 }}>
                  {marcados} de {total} {todosBloqueados ? 'obrigatórias' : 'permissões'}
                </div>
              </div>

              {!todosBloqueados && (
                <button
                  type="button"
                  onClick={toggleTodos}
                  aria-label={todos ? `Desmarcar todas as permissões de ${g.label}` : `Marcar todas as permissões de ${g.label}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    background: todos ? ui.accent : 'transparent',
                    color: todos ? '#fff' : ui.muted,
                    border: `1px solid ${todos ? ui.accent : ui.borderStrong}`,
                    borderRadius: 99,
                    padding: '4px 10px',
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  {todos ? <Ic name="check" size={12} /> : null}
                  {todos ? 'Todas marcadas' : 'Marcar todas'}
                </button>
              )}
            </div>

            {expandido && (
              <div
                style={{
                  borderTop: `1px solid ${ui.border}`,
                  padding: '4px 12px 10px 12px',
                }}
              >
                <div style={{ fontSize: 11, color: ui.muted, lineHeight: 1.5, padding: '8px 0 4px' }}>
                  {g.description}
                </div>
                {g.perms.map((p) => {
                  const on = (value & p.bit) !== 0
                  const lock = isLocked(p.bit)
                  return (
                    <label
                      key={p.bit}
                      style={{
                        display: 'flex',
                        gap: 10,
                        alignItems: 'flex-start',
                        padding: '7px 0',
                        cursor: lock ? 'default' : 'pointer',
                        opacity: lock ? 0.85 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={lock}
                        onChange={(e) =>
                          onChange(
                            e.target.checked ? value | p.bit : value & ~p.bit,
                          )
                        }
                        style={{ marginTop: 3, flexShrink: 0 }}
                      />
                      <span style={{ minWidth: 0 }}>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 13,
                            fontWeight: 600,
                            color: on ? ui.heading : ui.text,
                          }}
                        >
                          {p.label}
                          {lock && (
                            <span
                              style={{
                                fontSize: 10,
                                color: ui.warning,
                                fontWeight: 700,
                                marginLeft: 6,
                              }}
                            >
                              obrigatória
                            </span>
                          )}
                        </span>
                        {p.hint && (
                          <span
                            style={{
                              display: 'block',
                              fontSize: 11,
                              color: ui.muted,
                              lineHeight: 1.45,
                              marginTop: 2,
                            }}
                          >
                            {p.hint}
                          </span>
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {lockedHint && (
        <div style={{ fontSize: 11, color: ui.muted, lineHeight: 1.5 }}>{lockedHint}</div>
      )}
    </div>
  )
}

/** Rótulo legível de um conjunto de permissões, para resumo. */
export function describePerms(mask: number): string {
  if ((mask & PERMS.ADMINISTRATOR) !== 0) return 'Administrador'
  const nomes = Object.entries(PERM_LABELS)
    .filter(([bit]) => (mask & Number(bit)) !== 0)
    .map(([, label]) => label)
  if (!nomes.length) return 'Nenhuma permissão'
  if (nomes.length <= 2) return nomes.join(', ')
  return `${nomes.slice(0, 2).join(', ')} e mais ${nomes.length - 2}`
}