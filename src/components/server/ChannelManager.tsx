// Gerenciamento de canais e categorias.
//
// Duas tarefas que antes dividiam a mesma tela apertada: criar canal e criar
// categoria. Agora são diálogos próprios, largos, com validação e explicação de
// para que serve cada campo.
//
// Didático de propósito: o campo "categoria" não é óbvio para quem nunca usou
// Discord, e a posição da categoria decide a ordem na barra lateral.

import { useMemo, useState } from 'react'
import type { ChannelMeta } from '../../services/models'
import { groupByCategory } from '../../app/channels'
import { Ic } from '../../shared/icons'
import {
  Button,
  EmptyState,
  Modal,
  Notice,
  Select,
  TextArea,
  TextField,
  WIDTHS,
  ui,
} from '../../shared/ui'

export const CATEGORIAS_PADRAO = ['CANAIS DE TEXTO', 'CANAIS DE VOZ', 'CANAIS DE VÍDEO']

export function validateChannelName(
  nome: string,
  existentes: ChannelMeta[],
  editandoId?: string | null,
): string | null {
  const n = nome.trim()
  if (!n) return 'Dê um nome ao canal.'
  if (!/^[a-z0-9-]+$/.test(n.toLowerCase()))
    return 'Use apenas letras minúsculas, números e hífen. Ex.: geracao-antiga'
  if (n.length < 2) return 'O nome precisa ter pelo menos 2 caracteres.'
  if (n.length > 40) return 'O nome pode ter no máximo 40 caracteres.'
  const dup = existentes.some(
    (c) => c.id !== editandoId && norm(c.name) === norm(n),
  )
  if (dup) return 'Já existe um canal com esse nome.'
  return null
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-')
}

// ---------- criar / editar canal ----------

export function ChannelEditor({
  open,
  onClose,
  channels,
  channel,
  categorias,
  presetCategory,
  onSave,
  onDelete,
}: {
  open: boolean
  onClose: () => void
  channels: ChannelMeta[]
  channel: ChannelMeta | null
  categorias: string[]
  /** Categoria já escolhida por quem abriu o diálogo (botão "+" da sidebar). */
  presetCategory?: string
  onSave: (data: {
    name: string
    topic: string
    category: string
    kind: 'text' | 'voice' | 'video'
  }) => Promise<void>
  onDelete?: (channel: ChannelMeta) => Promise<void>
}) {
  const editando = channel !== null
  const [nome, setNome] = useState(channel?.name ?? '')
  const [topico, setTopico] = useState(channel?.topic ?? '')
  const [categoria, setCategoria] = useState(
    channel?.category ?? presetCategory ?? CATEGORIAS_PADRAO[0],
  )
  const [novaCategoria, setNovaCategoria] = useState('')
  const [tipo, setTipo] = useState<'text' | 'voice' | 'video'>(
    // `forum` existe no modelo mas não se cria aqui — só texto/voz/vídeo.
    channel?.kind === 'voice' || channel?.kind === 'video' ? channel.kind : 'text',
  )
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [tocou, setTocou] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const erroNome = validateChannelName(nome, channels, channel?.id)
  // Se a categoria não existe na lista, offercê-la como "criar nova".
  const categoriaNova = categoria.trim().toUpperCase()
  const precisaCriar = categoriaNova.length > 0 && !categorias.includes(categoriaNova)

  async function salvar() {
    setTocou(true)
    setErro(null)
    if (erroNome) return
    if (!categoriaNova) {
      setErro('Escolha ou crie uma categoria.')
      return
    }
    setSalvando(true)
    try {
      await onSave({ name: norm(nome), topic: topico.trim(), category: categoriaNova, kind: tipo })
      onClose()
    } catch (e: any) {
      setErro(String(e?.message ?? e))
    } finally {
      setSalvando(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editando ? `Editar #${channel.name}` : 'Criar canal'}
      subtitle={
        editando
          ? 'Renomear, mover ou mudar o tipo não afeta as mensagens já enviadas.'
          : 'Canais de texto servem para conversa. Canais de voz servem para chamada.'
      }
      width={WIDTHS.md}
      footer={
        <>
          {editando && onDelete && !confirmDelete && (
            <Button icon="trash" variant="danger" onClick={() => setConfirmDelete(true)}>
              Excluir
            </Button>
          )}
          <span style={{ flex: 1 }} />
          <Button onClick={onClose} disabled={salvando}>
            Cancelar
          </Button>
          <Button variant="success" icon="check" onClick={salvar} disabled={salvando} busy={salvando}>
            {editando ? 'Salvar' : 'Criar canal'}
          </Button>
        </>
      }
    >
      {confirmDelete && channel && (
        <Notice tone="danger" icon="warn">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Excluir #{channel.name}?
          </div>
          <div style={{ marginBottom: 10 }}>
            Todas as mensagens deste canal são apagadas junto. Não dá para desfazer.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                try {
                  await onDelete!(channel)
                  setConfirmDelete(false)
                  onClose()
                } catch (e: any) {
                  setErro(String(e?.message ?? e))
                  setConfirmDelete(false)
                }
              }}
            >
              Sim, excluir
            </Button>
            <Button onClick={() => setConfirmDelete(false)}>Cancelar</Button>
          </div>
        </Notice>
      )}

      {erro && (
        <div style={{ marginBottom: ui.lg }}>
          <Notice tone="danger" icon="warn">
            {erro}
          </Notice>
        </div>
      )}

      <TextField
        label="Nome do canal"
        value={nome}
        onChange={(v) => {
          setNome(v.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-'))
          setTocou(true)
        }}
        placeholder="ex.: ideias-de-produto"
        error={tocou ? erroNome : null}
        maxLength={40}
        autoFocus
        hint="O canal aparece na barra lateral como #nome-do-canal. Sem espaços ou acentos."
      />

      <TextArea
        label="Tópico (opcional)"
        value={topico}
        onChange={setTopico}
        rows={2}
        maxLength={200}
        placeholder="Sobre o que é este canal?"
        hint="Aparece no topo do canal, para quem entra saber do que se trata."
      />

      <Select
        label="Categoria"
        value={categoria}
        onChange={(v) => {
          if (v === '__nova__') {
            setNovaCategoria('NOVA CATEGORIA')
          } else {
            setCategoria(v)
            setNovaCategoria('')
          }
        }}
        options={[
          ...categorias.map((c) => ({ value: c, label: c })),
          { value: '__nova__', label: '+ Criar nova categoria' },
        ]}
        hint="A categoria define em que grupo o canal aparece na barra lateral."
      />

      {precisaCriar && (
        <TextField
          label="Nome da nova categoria"
          value={novaCategoria}
          onChange={(v) => setNovaCategoria(v.toUpperCase())}
          placeholder="ex.: PROJETOS"
          maxLength={30}
          hint="Grupos com o mesmo nome ficam juntos na barra lateral, nesta ordem."
        />
      )}

      {!editando && (
        <div style={{ marginBottom: ui.lg }}>
          <label style={LABEL}>Tipo do canal</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: ui.sm }}>
            {(
              [
                { k: 'text', label: 'Texto', desc: 'Conversa por mensagem', ic: 'hash' },
                { k: 'voice', label: 'Voz', desc: 'Chamada de áudio', ic: 'speaker' },
                { k: 'video', label: 'Vídeo', desc: 'Chamada com câmera', ic: 'video' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.k}
                type="button"
                onClick={() => setTipo(opt.k)}
                aria-pressed={tipo === opt.k}
                style={{
                  display: 'flex',
                  gap: 9,
                  alignItems: 'flex-start',
                  padding: '11px 12px',
                  background: tipo === opt.k ? `${ui.accent}22` : ui.input,
                  border: `1px solid ${tipo === opt.k ? ui.accent : ui.border}`,
                  borderRadius: ui.radius,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ color: tipo === opt.k ? ui.accent : ui.muted, marginTop: 1 }}>
                  <Ic name={opt.ic} size={16} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: ui.heading }}>
                    {opt.label}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: ui.muted, marginTop: 2 }}>
                    {opt.desc}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {editando && (
            <div style={{ fontSize: 11, color: ui.muted, marginTop: 6 }}>
              O tipo não pode ser alterado depois de criado.
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

// ---------- lista de canais por categoria ----------

export function ChannelList({
  channels,
  onEdit,
  onCreate,
}: {
  channels: ChannelMeta[]
  onEdit: (c: ChannelMeta) => void
  onCreate: () => void
}) {
  const grupos = useMemo(() => groupByCategory(channels), [channels])

  if (channels.length === 0) {
    return (
      <EmptyState
        icon="hash"
        title="Nenhum canal ainda"
        hint="Um servidor precisa de pelo menos um canal para as pessoas conversarem. Crie um canal de texto para começar."
        action={
          <Button variant="success" icon="plus" onClick={onCreate}>
            Criar o primeiro canal
          </Button>
        }
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: ui.xl }}>
      {grupos.map((g) => (
        <div key={g.category}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: ui.sm,
            }}
          >
            <span style={{ color: ui.muted, display: 'inline-flex' }}>
              <Ic name="folder" size={13} />
            </span>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, color: ui.muted }}>
              {g.category}
            </span>
            <span style={{ fontSize: 11, color: ui.muted, opacity: 0.7 }}>
              {g.channels.length} canal{g.channels.length === 1 ? '' : 'is'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {g.channels.map((c) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  background: ui.input,
                  border: `1px solid ${ui.border}`,
                  borderRadius: ui.radius,
                  padding: '11px 13px',
                }}
              >
                <span style={{ color: ui.muted, display: 'inline-flex', flexShrink: 0 }}>
                  <Ic name={c.kind === 'voice' ? 'speaker' : c.kind === 'video' ? 'video' : 'hash'} size={16} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: ui.heading }}>
                    {c.name}
                  </div>
                  {c.topic && (
                    <div
                      style={{
                        fontSize: 12,
                        color: ui.muted,
                        marginTop: 2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.topic}
                    </div>
                  )}
                </div>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: 0.4,
                    color: ui.muted,
                    background: ui.surfaceHover,
                    padding: '3px 7px',
                    borderRadius: 4,
                    flexShrink: 0,
                  }}
                >
                  {c.kind === 'text' ? 'TEXTO' : c.kind === 'voice' ? 'VOZ' : 'VÍDEO'}
                </span>
                <Button icon="edit" onClick={() => onEdit(c)} ariaLabel={`Editar canal ${c.name}`}>
                  Editar
                </Button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------- categorias ----------

export function CategoryManager({
  channels,
  onCreate,
  onMoveChannels,
}: {
  channels: ChannelMeta[]
  onCreate: (nome: string) => void
  /** Mover o canal para outra categoria. */
  onMoveChannels: (canalId: string, categoria: string) => Promise<void>
}) {
  const grupos = useMemo(() => groupByCategory(channels), [channels])
  const [selecionado, setSelecionado] = useState<string>(grupos[0]?.category ?? '')
  const [novo, setNovo] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const grupo = grupos.find((g) => g.category === selecionado)

  function criar() {
    const n = novo.trim().toUpperCase()
    if (!n) {
      setErro('Dê um nome à categoria.')
      return
    }
    if (grupos.some((g) => g.category === n)) {
      setErro('Já existe uma categoria com esse nome.')
      return
    }
    onCreate(n)
    setNovo('')
    setErro(null)
    setSelecionado(n)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: ui.lg }}>
      <Notice tone="info" icon="info">
        Categorias são só uma forma de organizar a barra lateral: elas agrupam canais
        com o mesmo nome. Criar uma categoria não cria nenhum canal dentro dela.
      </Notice>

      <div
        style={{
          display: 'flex',
          gap: ui.sm,
          alignItems: 'flex-end',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <TextField
            label="Nova categoria"
            value={novo}
            onChange={(v) => setNovo(v.toUpperCase())}
            placeholder="ex.: PROJETOS"
            maxLength={30}
            error={erro}
            ariaLabel="Nome da nova categoria"
          />
        </div>
        <Button variant="success" icon="plus" onClick={criar} style={{ marginBottom: ui.lg }}>
          Criar categoria
        </Button>
      </div>

      {grupos.length === 0 ? (
        <EmptyState
          icon="folder"
          title="Nenhuma categoria ainda"
          hint="Crie a primeira categoria acima para começar a organizar os canais."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: ui.md }}>
          {grupos.map((g) => (
            <div
              key={g.category}
              style={{
                background: ui.surface,
                border: `1px solid ${g.category === selecionado ? ui.accent : ui.border}`,
                borderRadius: ui.radius,
                overflow: 'hidden',
              }}
            >
              <button
                type="button"
                onClick={() => setSelecionado(g.category)}
                aria-expanded={g.category === selecionado}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  width: '100%',
                  padding: '11px 13px',
                  background: g.category === selecionado ? ui.input : 'transparent',
                  border: 'none',
                  color: ui.text,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ color: ui.muted, display: 'inline-flex' }}>
                  <Ic name="chevronRight" size={14} rotate={g.category === selecionado ? 90 : 0} />
                </span>
                <span style={{ color: ui.accent, display: 'inline-flex' }}>
                  <Ic name="folder" size={15} />
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 800, color: ui.heading }}>
                  {g.category}
                </span>
                <span style={{ fontSize: 11, color: ui.muted, fontWeight: 700 }}>
                  {g.channels.length}
                </span>
              </button>

              {g.category === selecionado && grupo && (
                <div style={{ padding: '10px 13px 13px 13px', borderTop: `1px solid ${ui.border}` }}>
                  {grupo.channels.length === 0 ? (
                    <div style={{ fontSize: 12, color: ui.muted, lineHeight: 1.5 }}>
                      Esta categoria está vazia. Mova um canal para cá para usá-la.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {grupo.channels.map((c) => (
                        <div
                          key={c.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 9,
                            background: ui.input,
                            border: `1px solid ${ui.border}`,
                            borderRadius: ui.radiusSm,
                            padding: '8px 10px',
                            flexWrap: 'wrap',
                          }}
                        >
                          <span style={{ color: ui.muted, display: 'inline-flex' }}>
                            <Ic name="hash" size={13} />
                          </span>
                          <span style={{ flex: 1, minWidth: 90, fontSize: 13, color: ui.text, fontWeight: 600 }}>
                            {c.name}
                          </span>
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 11, color: ui.muted }}>Mover para</span>
                            <select
                              value={c.category}
                              onChange={(e) => onMoveChannels(c.id, e.target.value)}
                              aria-label={`Mover canal ${c.name}`}
                              style={{
                                background: ui.input,
                                color: ui.text,
                                border: `1px solid ${ui.border}`,
                                borderRadius: 5,
                                padding: '5px 7px',
                                fontSize: 11,
                              }}
                            >
                              {grupos.map((dest) => (
                                <option key={dest.category} value={dest.category}>
                                  {dest.category}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const LABEL: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.6,
  color: ui.muted,
  marginBottom: 6,
  textTransform: 'uppercase',
}