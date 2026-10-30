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
  onClose,
  onRenamed,
  onChanged,
}: {
  convId: string
  title: string
  myFp: string
  friends: GroupFriend[]
  profiles: Record<string, ProfileView>
  onClose: () => void
  /** Chamado quando o título muda (o shell atualiza a lista de conversas). */
  onRenamed: (titulo: string) => void
  /** Chamado quando o roster muda (o shell recarrega contagem/mensagens). */
  onChanged: () => void
}) {
  const [roster, setRoster] = useState<Roster>([])
  const [carregando, setCarregando] = useState(true)
  const [nome, setNome] = useState(title)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [addFp, setAddFp] = useState('')

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

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={onClose}>Fechar</Button>
      </div>
    </div>
  )
}
