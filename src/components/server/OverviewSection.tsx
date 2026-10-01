// Visão geral do servidor: identidade e descrição.
//
// Antes era um `<input>` com id="srv-rename" lido por `document.getElementById`
// dentro do onClick do botão — ou seja, o valor vinha do DOM, não do estado do
// React. Isso quebrava com qualquer re-render e impedia validação. Agora é
// estado real, com salvar só sujo.

import { useEffect, useState } from 'react'
import { Ic } from '../../shared/icons'
import { Button, Card, DataRow, Notice, TextArea, TextField, ui } from '../../shared/ui'

export function OverviewSection({
  serverName,
  description,
  category,
  ownerFp,
  myFp,
  serverId,
  ehDono,
  onRename,
  onSetMeta,
  onError,
}: {
  serverName: string
  description?: string
  category?: string
  ownerFp: string
  myFp: string | undefined
  serverId: string
  ehDono: boolean
  onRename: (nome: string) => Promise<void>
  onSetMeta: (patch: { description?: string; category?: string }) => Promise<void>
  onError: (msg: string | null) => void
}) {
  const [nome, setNome] = useState(serverName)
  const [desc, setDesc] = useState(description ?? '')
  const [cat, setCat] = useState(category ?? '')
  const [salvando, setSalvando] = useState(false)

  // Reabrir a tela com outro servidor tem que mostrar o servidor novo.
  useEffect(() => {
    setNome(serverName)
    setDesc(description ?? '')
    setCat(category ?? '')
  }, [serverName, description, category])

  const erroNome =
    !nome.trim()
      ? 'O servidor precisa de um nome.'
      : nome.trim().length < 2
        ? 'O nome precisa ter pelo menos 2 caracteres.'
        : nome.trim().length > 60
          ? 'O nome pode ter no máximo 60 caracteres.'
          : null

  const nomeSujo = nome.trim() !== serverName
  const metaSujo = desc !== (description ?? '') || cat !== (category ?? '')
  const algumSujeira = nomeSujo || metaSujo

  async function salvar() {
    if (erroNome) return
    setSalvando(true)
    onError(null)
    try {
      if (nomeSujo) await onRename(nome.trim())
      if (metaSujo) await onSetMeta({ description: desc.trim(), category: cat.trim() })
    } catch (e: any) {
      onError(String(e?.message ?? e))
    } finally {
      setSalvando(false)
    }
  }

  function descartar() {
    setNome(serverName)
    setDesc(description ?? '')
    setCat(category ?? '')
  }

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: ui.xl }}>
      <Card
        icon="server"
        title="Identidade do servidor"
        subtitle="O nome e a descrição aparecem para todo mundo que vê este servidor."
      >
        <TextField
          label="Nome do servidor"
          value={nome}
          onChange={setNome}
          maxLength={60}
          error={nome.trim() && erroNome ? erroNome : null}
          disabled={!ehDono}
          hint={
            ehDono
              ? undefined
              : 'Só o dono do servidor pode mudar o nome.'
          }
        />

        <TextArea
          label="Descrição"
          value={desc}
          onChange={setDesc}
          rows={3}
          maxLength={200}
          placeholder="Do que trata este servidor?"
          disabled={!ehDono}
          hint="Aparece na lista de servidores e ajuda as pessoas a entenderem o que encontrarão aqui."
        />

        <TextField
          label="Categoria (opcional)"
          value={cat}
          onChange={setCat}
          maxLength={40}
          placeholder="ex.: comunidade, trabalho, estudo"
          disabled={!ehDono}
          hint="Agrupa este servidor com outros parecidos na hora de escolher entre vários."
        />

        {ehDono && algumSujeira && (
          <div
            style={{
              display: 'flex',
              gap: ui.sm,
              justifyContent: 'flex-end',
              paddingTop: ui.sm,
              borderTop: `1px solid ${ui.border}`,
              flexWrap: 'wrap',
            }}
          >
            <Button onClick={descartar} disabled={salvando}>
              Descartar
            </Button>
            <Button
              variant="success"
              icon="save"
              onClick={salvar}
              disabled={salvando || !!erroNome}
              busy={salvando}
            >
              Salvar alterações
            </Button>
          </div>
        )}
      </Card>

      <Card icon="info" title="Informações técnicas" subtitle="Identificadores úteis para diagnosticar problemas.">
        <DataRow label="Dono">
          {ownerFp === myFp ? 'Você' : `${ownerFp.slice(0, 16)}…`}
        </DataRow>
        <DataRow label="ID do servidor">
          <code style={{ fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>{serverId}</code>
        </DataRow>
        <DataRow label="Impressão digital">
          <code style={{ fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
            {ownerFp.slice(0, 24)}…
          </code>
        </DataRow>
        <div style={{ marginTop: ui.md }}>
          <Notice tone="info" icon="help">
            O ID identifica este servidor entre todos os da rede. Ao reportar um problema,
            inclua-o: ele permite encontrar o mesmo servidor em outro dispositivo.
          </Notice>
        </div>
      </Card>

      <Card icon="help" title="Como este servidor funciona" subtitle="O básico para quem está começando.">
        <ul style={{ display: 'flex', flexDirection: 'column', gap: ui.md, listStyle: 'none' }}>
          {[
            {
              ic: 'hash' as const,
              t: 'Canais são as conversas',
              d: 'Cada canal é um assunto separado. Texto para conversa por mensagem; voz e vídeo para chamada.',
            },
            {
              ic: 'folder' as const,
              t: 'Categorias organizam os canais',
              d: 'Na barra lateral, canais com o mesmo nome ficam juntos. É só organização visual.',
            },
            {
              ic: 'crown' as const,
              t: 'Cargos dizem o que cada um pode fazer',
              d: 'Um cargo reúne permissões. Você dá cargos às pessoas em vez de mexer em cada pessoa.',
            },
            {
              ic: 'users' as const,
              t: 'Todo mundo pode entrar',
              d: 'Quem tem o link de convite entra direto e vira membro. Não há pedido de aprovação.',
            },
          ].map((item) => (
            <li key={item.t} style={{ display: 'flex', gap: 11 }}>
              <span style={{ color: ui.accent, display: 'inline-flex', marginTop: 1, flexShrink: 0 }}>
                <Ic name={item.ic} size={16} />
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: ui.heading }}>
                  {item.t}
                </span>
                <span style={{ display: 'block', fontSize: 12, color: ui.muted, marginTop: 2, lineHeight: 1.5 }}>
                  {item.d}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}