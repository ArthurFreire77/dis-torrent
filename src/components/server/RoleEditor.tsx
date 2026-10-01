// Criação e edição de cargo.
//
// Antes: uma caixa de 200px ao lado de um formulário, com os 10 checkboxes de
// permissão empilhados e um botão "Excluir" vermelho ao lado de "Salvar".
// O nome era um `<input>` solto sem validação (dava para criar cargo sem nome
// ou com nome de 3 letras), e não havia ideia de posição/hierarquia.
//
// Agora: diálogo largo, com nome validado, cor, permissões agrupadas
// (PermissionEditor), posição explícita com explicação de hierarquia, e
// pré-visualização de quem é afetado.

import { useMemo, useState } from 'react'
import {
  DEFAULT_ROLE_COLORS,
  PERMS,
  type RoleView,
} from '../../services/models'
import { Ic } from '../../shared/icons'
import {
  Button,
  Modal,
  Notice,
  Select,
  TextField,
  WIDTHS,
  ui,
} from '../../shared/ui'
import { ALL_PERM_BITS, PermissionEditor, describePerms } from './PermissionEditor'

/** Regras de nome. Ditas ao usuário no erro, não só no código. */
export function validateRoleName(
  nome: string,
  existentes: { id: string; name: string }[],
  editandoId?: string | null,
): string | null {
  const n = nome.trim()
  if (!n) return 'Dê um nome ao cargo.'
  if (n.length < 2) return 'O nome precisa ter pelo menos 2 caracteres.'
  if (n.length > 32) return 'O nome pode ter no máximo 32 caracteres.'
  const dup = existentes.some(
    (r) => r.id !== editandoId && r.name.trim().toLowerCase() === n.toLowerCase(),
  )
  if (dup) return 'Já existe um cargo com esse nome.'
  return null
}

export function RoleEditor({
  open,
  onClose,
  roles,
  /** Cargo em edição, ou null para criar. */
  role,
  /** Nº de membros por cargo, para a pré-visualização de hierarquia. */
  memberCount,
  onSave,
  onDelete,
}: {
  open: boolean
  onClose: () => void
  roles: RoleView[]
  role: RoleView | null
  memberCount: Record<string, number>
  onSave: (data: {
    name: string
    color: string
    permissions: number
    hoist: boolean
    mentionable: boolean
    position: number
  }) => Promise<void>
  onDelete: (role: RoleView) => Promise<void>
}) {
  const editando = role !== null

  const [nome, setNome] = useState(role?.name ?? '')
  const [cor, setCor] = useState(role?.color ?? DEFAULT_ROLE_COLORS[0])
  const [perms, setPerms] = useState(role?.permissions ?? (PERMS.VIEW_CHANNEL | PERMS.SEND_MESSAGES))
  const [hoist, setHoist] = useState(role?.hoist ?? true)
  const [mentionable, setMentionable] = useState(role?.mentionable ?? true)
  const [posicao, setPosicao] = useState(String(role?.position ?? 0))
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [tocou, setTocou] = useState(false)

  // Hierarquia: um cargo aparece acima dos outros conforme a posição. Menor
  // número = mais alto na lista.
  const opcoesPosicao = useMemo(() => {
    const maior = roles.reduce((acc, r) => Math.max(acc, r.position), 0)
    const arr: { value: string; label: string }[] = []
    for (let i = 0; i <= maior + 1; i++) {
      const acima = roles.filter((r) => r.position < i).length
      const mesmo = roles.filter((r) => r.position === i).length
      arr.push({
        value: String(i),
        label:
          i === 0
            ? '0 — no topo da lista de membros'
            : `${i} — abaixo de ${acima} cargo${acima === 1 ? '' : 's'}${
                mesmo ? ` (mesma posição que ${mesmo})` : ''
              }`,
      })
    }
    return arr
  }, [roles])

  const erroNome = validateRoleName(nome, roles, role?.id)
  const semPermissao = (perms & ALL_PERM_BITS.reduce((a, b) => a | b, 0)) === 0

  async function salvar() {
    setTocou(true)
    setErro(null)
    if (erroNome) return
    if (semPermissao) {
      setErro('Escolha pelo menos uma permissão, ou o cargo não faz nada.')
      return
    }
    setSalvando(true)
    try {
      await onSave({
        name: nome.trim(),
        color: cor,
        permissions: perms,
        hoist,
        mentionable,
        position: Number(posicao) || 0,
      })
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
      title={editando ? `Editar ${role.name}` : 'Novo cargo'}
      subtitle={
        editando
          ? 'As mudanças valem para todos que têm este cargo.'
          : 'Cargos agrupam pessoas e definem o que elas podem fazer.'
      }
      width={WIDTHS.lg}
      footer={
        <>
          {editando && !confirmDelete && (
            <Button
              icon="trash"
              variant="danger"
              onClick={() => setConfirmDelete(true)}
              ariaLabel="Excluir cargo"
            >
              Excluir
            </Button>
          )}
          <span style={{ flex: 1 }} />
          <Button onClick={onClose} disabled={salvando}>
            Cancelar
          </Button>
          <Button
            variant="success"
            onClick={salvar}
            disabled={salvando}
            busy={salvando}
            icon="check"
          >
            {editando ? 'Salvar alterações' : 'Criar cargo'}
          </Button>
        </>
      }
    >
      {confirmDelete && role && (
        <Notice tone="danger" icon="warn">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Excluir “{role.name}”?
          </div>
          <div style={{ marginBottom: 10 }}>
            {memberCount[role.id] > 0
              ? `${memberCount[role.id]} pessoa${memberCount[role.id] === 1 ? '' : 's'} deixa${memberCount[role.id] === 1 ? '' : 'm'} de ter este cargo. `
              : 'Ninguém tem este cargo. '}
            As permissões somem junto. Não dá para desfazer.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="danger" icon="trash" onClick={async () => {
              try {
                await onDelete(role)
                setConfirmDelete(false)
                onClose()
              } catch (e: any) {
                setErro(String(e?.message ?? e))
                setConfirmDelete(false)
              }
            }}>
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

      {/* --- Identidade --- */}
      <TextField
        label="Nome do cargo"
        value={nome}
        onChange={(v) => {
          setNome(v)
          setTocou(true)
        }}
        placeholder="ex.: Moderador"
        error={tocou ? erroNome : null}
        maxLength={32}
        autoFocus
        hint="Como o cargo aparece na lista de membros e nas menções."
      />

      <div style={{ marginBottom: ui.lg }}>
        <label style={LABEL}>Cor</label>
        <div
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
          role="radiogroup"
          aria-label="Cor do cargo"
        >
          {DEFAULT_ROLE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={cor === c}
              aria-label={`Cor ${c}`}
              onClick={() => setCor(c)}
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                background: c,
                border: cor === c ? `3px solid ${ui.heading}` : `2px solid ${ui.borderStrong}`,
                cursor: 'pointer',
                padding: 0,
              }}
            />
          ))}
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: ui.muted,
              cursor: 'pointer',
            }}
          >
            Personalizada
            <input
              type="color"
              value={cor}
              onChange={(e) => setCor(e.target.value)}
              aria-label="Escolher cor personalizada"
              style={{
                width: 30,
                height: 30,
                padding: 0,
                border: `1px solid ${ui.borderStrong}`,
                borderRadius: '50%',
                background: 'none',
                cursor: 'pointer',
              }}
            />
          </label>
        </div>
      </div>

      {/* --- Pré-visualização --- */}
      <div
        style={{
          background: ui.input,
          border: `1px solid ${ui.border}`,
          borderRadius: ui.radius,
          padding: 12,
          marginBottom: ui.lg,
        }}
      >
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.6, color: ui.muted, marginBottom: 8 }}>
          PRÉ-VISUALIZAÇÃO
        </div>
        <span
          style={{
            color: cor,
            background: `${cor}22`,
            border: `1px solid ${cor}66`,
            borderRadius: 99,
            padding: '3px 10px',
            fontSize: 13,
            fontWeight: 800,
            display: 'inline-block',
          }}
        >
          {nome.trim() || 'Cargo sem nome'}
        </span>
        <div style={{ fontSize: 11, color: ui.muted, marginTop: 8, lineHeight: 1.5 }}>
          {describePerms(perms)}
        </div>
      </div>

      {/* --- Permissões --- */}
      <div style={{ marginBottom: ui.lg }}>
        <label style={LABEL}>Permissões</label>
        <PermissionEditor value={perms} onChange={setPerms} />
      </div>

      {/* --- Hierarquia --- */}
      <Select
        label="Posição na hierarquia"
        value={posicao}
        onChange={setPosicao}
        options={opcoesPosicao}
        hint="Cargos mais altos aparecem primeiro na lista de membros. Se dois cargos tiverem a mesma posição, a cor de quem está online serve de desempate."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
        <CheckRow
          checked={hoist}
          onChange={setHoist}
          label="Mostrar membros deste cargo separadamente"
          hint="Agrupa as pessoas com este cargo numa seção própria, separada das outras."
        />
        <CheckRow
          checked={mentionable}
          onChange={setMentionable}
          label="Permitir menção com @"
          hint="Se desligado, ninguém consegue marcar este cargo com @cargo."
        />
      </div>

      {semPermissao && (
        <div style={{ marginTop: ui.lg }}>
          <Notice tone="warning" icon="warn">
            Este cargo não tem nenhuma permissão marcada — ele não faz nada no servidor.
          </Notice>
        </div>
      )}
    </Modal>
  )
}

function CheckRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '10px 12px',
        background: ui.input,
        border: `1px solid ${ui.border}`,
        borderRadius: ui.radius,
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3 }}
      />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: ui.text }}>
          {label}
        </span>
        {hint && (
          <span style={{ display: 'block', fontSize: 11, color: ui.muted, marginTop: 2, lineHeight: 1.45 }}>
            {hint}
          </span>
        )}
      </span>
    </label>
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

/** Lista lateral de cargos, com contagem e destaque da posição. */
export function RoleList({
  roles,
  selectedId,
  onSelect,
  onCreate,
  memberCount,
}: {
  roles: RoleView[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  memberCount: Record<string, number>
}) {
  const ordenados = useMemo(
    () => [...roles].sort((a, b) => b.position - a.position),
    [roles],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        onClick={onCreate}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          background: 'transparent',
          border: `1px dashed ${ui.borderStrong}`,
          borderRadius: ui.radius,
          color: ui.muted,
          fontSize: 13,
          fontWeight: 700,
          cursor: 'pointer',
          marginBottom: ui.sm,
        }}
      >
        <Ic name="plus" size={15} />
        Novo cargo
      </button>

      {ordenados.map((r) => {
        const ativo = r.id === selectedId
        const n = memberCount[r.id] ?? 0
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onSelect(r.id)}
            aria-current={ativo ? 'true' : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '9px 11px',
              background: ativo ? ui.accent : 'transparent',
              border: 'none',
              borderLeft: `3px solid ${r.color}`,
              borderRadius: ui.radiusSm,
              color: ativo ? '#fff' : ui.text,
              cursor: 'pointer',
              textAlign: 'left',
              width: '100%',
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: r.color,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                fontWeight: 700,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.name}
            </span>
            {n > 0 && (
              <span
                style={{
                  fontSize: 11,
                  color: ativo ? '#ffffffcc' : ui.muted,
                  fontWeight: 700,
                }}
              >
                {n}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}