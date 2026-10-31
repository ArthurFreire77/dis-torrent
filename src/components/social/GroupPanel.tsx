// Painel do grupo de DM: título editável, lista de membros e adicionar/remover.
//
// BUG QUE ISTO CORRIGE: o cabeçalho de um grupo mostrava "0 membros" — e era
// literalmente sempre zero, porque o contador lia
// `localStorage['distorrent:extras:group_members:<id>']` na marra. Essa chave só
// existe no MODO NAVEGADOR; no app nativo o roster está no SQLite e a leitura
// direta dava `null`. Além do número errado, não havia NENHUMA tela para ver
// quem estava no grupo, remover alguém ou renomear.
//
// Regras de honestidade:
//   - a lista vem do motor (`groupMembers`), nunca de cache da UI;
//   - remover/renomear podem ser recusados pelo core (grupo inexistente, título
//     vazio) e o erro é MOSTRADO, não engolido;
//   - o criador não aparece com botão de remover (o core recusa, e oferecer um
//     botão que sempre falha seria mentira).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { services } from '../../services'
import type { ProfileView } from '../../services/models'
import { Ic } from '../../shared/icons'
import { Button, IconButton, Notice, TextField, ui } from '../../shared/ui'
import { Tooltip } from '../../shared/Tooltip'
import { copyText } from '../../shared/clipboard'

/** Roster vindo do motor: `[fingerprint, apelido]` (apelido pode ser vazio). */
type Roster = [string, string][]

/**
 * Amigo no formato MÍNIMO que este painel precisa.
 *
 * O shell guarda `{fp, nickname}`; o roster social completo (`FriendView`) tem
 * addr/pubkey/last_seen, que não são usados aqui. Pedir o tipo completo
 * obrigaria o shell a inventar campos — o contrato fica no que é consumido.
 */
export interface GroupFriend {
  fp: string
  nickname: string
}

function shortFp(fp: string): string {
  return fp.slice(0, 12)
}
export function GroupPanel({
  convId,
  title,
  myFp,
  friends,
  profiles,
  onlineFps,
  onClose,
  onRenamed,
  onChanged,
}: {
  convId: string
  title: string
  myFp: string
  friends: GroupFriend[]
  profiles: Record<string, ProfileView>
  /** fps com sessão viva agora (presença real, não "tem gente na lista"). */
  onlineFps?: Set<string>
  onClose: () => void
  onRenamed: (titulo: string) => void
  onChanged: () => void
}) {
  const [roster, setRoster] = useState<Roster>([])
  const [carregando, setCarregando] = useState(true)
  const [nome, setNome] = useState(title)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [addFp, setAddFp] = useState('')
  /** Menu de saída do grupo (o dono escolhe para todos ou só para ele). */
  const [menuSair, setMenuSair] = useState(false)

  const carregar = useCallback(async () => {
    setCarregando(true)
    try {
      setRoster(await services.groupMembers(convId))
    } catch (e) {
      setErro(String((e as Error)?.message ?? e))
      setRoster([])
    } finally {
      setCarregando(false)
    }
  }, [convId])

  useEffect(() => { void carregar() }, [carregar])
  useEffect(() => { setNome(title) }, [title])

  // Amigos que ainda NÃO estão no grupo: é a lista que faz sentido oferecer.
  const foraDoGrupo = useMemo(() => {
    const dentro = new Set(roster.map(([fp]) => fp))
    return friends.filter((f) => !dentro.has(f.fp))
  }, [friends, roster])

  const nomeDe = useCallback(
    (fp: string, apelido: string) => {
      if (fp === myFp) return `${apelido || profiles[fp]?.display_name || shortFp(fp)} (você)`
      return apelido || profiles[fp]?.display_name || friends.find((f) => f.fp === fp)?.nickname || shortFp(fp)
    },
    [friends, myFp, profiles],
  )

  async function renomear() {
    const novo = nome.trim()
    if (!novo || novo === title) return
    setSalvando(true)
    setErro(null)
    try {
      await services.groupRename(convId, novo)
      onRenamed(novo)
      setAviso('Nome do grupo salvo.')
    } catch (e) {
      setErro(String((e as Error)?.message ?? e))
    } finally {
      setSalvando(false)
    }
  }

  async function remover(fp: string) {
    setErro(null)
    try {
      await services.groupRemove(convId, fp)
      await carregar()
      onChanged()
    } catch (e) {
      setErro(String((e as Error)?.message ?? e))
    }
  }

  /** Sair do grupo (membro) ou apagar (dono, com a escolha). */
  const souCriador = roster.length > 0 && roster[0][0] === myFp

  async function sairParaMim() {
    setErro(null); setSalvando(true)
    try {
      if (souCriador) await services.groupDeleteLocal(convId)
      else await services.groupLeave(convId)
      onChanged(); onClose()
    } catch (e) { setErro(String((e as Error)?.message ?? e)) }
    finally { setSalvando(false) }
  }

  async function apagarParaTodos() {
    setErro(null); setSalvando(true)
    try {
      await services.groupDelete(convId)
      onChanged(); onClose()
    } catch (e) { setErro(String((e as Error)?.message ?? e)) }
    finally { setSalvando(false) }
  }

  async function adicionar() {
    const fp = addFp.trim()
    if (!fp) return
    setErro(null)
    try {
      await services.groupAdd(convId, fp)
      setAddFp('')
      await carregar()
      onChanged()
    } catch (e) {
      setErro(String((e as Error)?.message ?? e))
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: ui.md }}>
      {erro && <Notice tone="danger" icon="warn">{erro}</Notice>}
      {aviso && <Notice tone="success" icon="check">{aviso}</Notice>}

      <div style={{ display: 'flex', gap: ui.sm, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <TextField
            label="Nome do grupo"
            value={nome}
            onChange={setNome}
            maxLength={64}
            ariaLabel="Nome do grupo"
            hint="Todo mundo no grupo vê este nome."
          />
        </div>
        <div style={{ paddingBottom: 22 }}>
          <Button
            variant="primary"
            icon="check"
            busy={salvando}
            disabled={!nome.trim() || nome.trim() === title}
            onClick={() => void renomear()}
          >
            Salvar
          </Button>
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: ui.sm }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: ui.muted, flex: 1 }}>
            Membros — {roster.length}
          </span>
          {carregando && <span style={{ fontSize: 11, color: ui.muted }}>carregando…</span>}
        </div>

        {roster.length === 0 && !carregando && (
          <div style={{ fontSize: 12, color: ui.muted, lineHeight: 1.5 }}>
            O motor não devolveu nenhum membro para este grupo.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {roster.map(([fp, apelido]) => (
            <div
              key={fp}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px',
                background: ui.surface, border: `1px solid ${ui.border}`, borderRadius: 8,
              }}
            >
              {/* Presença REAL: sessão viva agora (não "está no roster"). */}
              <span
                title={fp === myFp ? 'você' : onlineFps?.has(fp) ? 'online agora' : 'offline'}
                style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: fp === myFp ? ui.success : onlineFps?.has(fp) ? ui.success : ui.muted,
                  boxShadow: fp === myFp || onlineFps?.has(fp) ? `0 0 6px ${ui.success}88` : 'none',
                }}
              />
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: ui.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {nomeDe(fp, apelido)}
              </span>
              <Tooltip label="Copiar fingerprint">
                <span>
                  <IconButton icon="copy" label={`Copiar o ID de ${nomeDe(fp, apelido)}`} onClick={() => void copyText(fp)} />
                </span>
              </Tooltip>
              {fp !== myFp && (
                <Tooltip label="Remover do grupo">
                  <span>
                    <IconButton
                      icon="trash"
                      label={`Remover ${nomeDe(fp, apelido)} do grupo`}
                      onClick={() => void remover(fp)}
                    />
                  </span>
                </Tooltip>
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: ui.muted, marginBottom: ui.sm }}>
          Adicionar alguém
        </div>
        {foraDoGrupo.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {foraDoGrupo.map((f) => (
              <button
                key={f.fp}
                type="button"
                onClick={() => { setAddFp(f.fp); void services.groupAdd(convId, f.fp).then(carregar).then(onChanged).catch((e) => setErro(String((e as Error)?.message ?? e))) }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700,
                  background: ui.input, color: ui.text, border: `1px solid ${ui.border}`,
                  borderRadius: 99, padding: '5px 11px', cursor: 'pointer',
                }}
              >
                <Ic name="plus" size={12} />
                {f.nickname || shortFp(f.fp)}
              </button>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: ui.muted, lineHeight: 1.5 }}>
            Todos os seus amigos já estão neste grupo.
          </div>
        )}

        <div style={{ display: 'flex', gap: ui.sm, alignItems: 'flex-end', marginTop: ui.sm }}>
          <div style={{ flex: 1 }}>
            <TextField
              value={addFp}
              onChange={setAddFp}
              placeholder="fingerprint de quem não é amigo"
              ariaLabel="Fingerprint para adicionar ao grupo"
            />
          </div>
          <Button icon="plus" disabled={!addFp.trim()} onClick={() => void adicionar()}>
            Adicionar
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: ui.sm }}>
        <div style={{ position: 'relative' }}>
          <Button variant="danger" icon="minus" busy={salvando} onClick={() => setMenuSair((v) => !v)}>
            {souCriador ? 'Apagar grupo' : 'Sair do grupo'}
          </Button>
          {menuSair && (
            <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, background: ui.surface, border: `1px solid ${ui.border}`, borderRadius: 8, padding: 6, display: 'flex', flexDirection: 'column', gap: 2, boxShadow: '0 8px 24px rgba(0,0,0,.45)', zIndex: 5, minWidth: 230 }}>
              {souCriador ? (
                <>
                  <button type="button" onClick={() => { setMenuSair(false); if (confirm(`Apagar "${title}" para TODOS? Ninguém mais vê o grupo.`)) void apagarParaTodos() }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: ui.danger, padding: '7px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>Apagar para todos</button>
                  <button type="button" onClick={() => { setMenuSair(false); if (confirm(`Apagar "${title}" só para você? Os outros continuam no grupo.`)) void sairParaMim() }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: ui.text, padding: '7px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5 }}>Apagar só para mim</button>
                </>
              ) : (
                <button type="button" onClick={() => { setMenuSair(false); if (confirm(`Sair do grupo "${title}"? Você deixa de ver as mensagens dele.`)) void sairParaMim() }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: ui.danger, padding: '7px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>Sair do grupo</button>
              )}
            </div>
          )}
        </div>
        <Button onClick={onClose}>Fechar</Button>
      </div>
    </div>
  )
}
