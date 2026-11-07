// Aba de permissões administrativas do bot.
// Separada de BotPanel.tsx (que ficou grande); recebe tudo por props.

import { BOT_PERM_DEFS, BOT_PERM_ALL, BOT_PERMS } from '../../services/botCommands'
import { Button, Card, Notice, ui } from '../../shared/ui'
import { chip } from './botPanelStyles'

export function BotPermissionsTab({ perms, setPerms }: {
  perms: number
  setPerms: (next: number | ((p: number) => number)) => void
}) {
  return (
        <Card title="Permissões administrativas" subtitle="O bot nunca tem mais poder do que isto. O dono do servidor nunca é alvo." icon="gear">
          <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
            {BOT_PERM_DEFS.map((d) => {
              const on = (perms & d.bit) !== 0
              return (
                <label key={d.bit} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 10px', background: on ? ui.surfaceHover : ui.surface, border: `1px solid ${on ? ui.accent : ui.border}`, borderRadius: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={on}
                    style={{ marginTop: 2 }}
                    onChange={() => setPerms((p) => (on ? p & ~d.bit : p | d.bit))}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: ui.heading }}>{d.label}</span>
                    <span style={{ display: 'block', fontSize: 11.5, color: ui.muted }}>{d.hint}</span>
                    <span style={{ display: 'block', fontSize: 11, color: ui.muted, marginTop: 2, fontFamily: 'JetBrains Mono,monospace' }}>
                      {d.commands.map((c) => `/${c}`).join('  ')}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          <div style={{ marginTop: ui.md, display: 'flex', gap: ui.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={chip(perms === 0 ? undefined : 'ok')}>
              {perms === 0 ? 'sem poder administrativo' : `${BOT_PERM_DEFS.filter((d) => (perms & d.bit) !== 0).length} de ${BOT_PERM_DEFS.length} concedidas`}
            </span>
            <Button variant="ghost" icon="minus" onClick={() => setPerms(0)}>
              Remover todas
            </Button>
            <Button variant="ghost" icon="shield" onClick={() => setPerms(BOT_PERM_ALL)}>
              Conceder todas
            </Button>
          </div>
          <Notice tone="warning" icon="info">
            Conceder banir/silenciar permite que o bot remova membros de verdade. A validação é feita no
            core a cada ação — a interface não é a barreira.
          </Notice>
          {perms === BOT_PERM_ALL && (
            <Notice tone="danger" icon="warn">
              Tudo concedido inclui montar o servidor, limpar canais e abrir entrada pública. Um bot
              comprometido pode apagar canais inteiros. Prefira conceder só o que ele usa.
            </Notice>
          )}
          {(perms & BOT_PERMS.MANAGE) !== 0 && (perms & (BOT_PERMS.STRUCTURE | BOT_PERMS.PURGE)) === 0 && (
            <Notice tone="info" icon="info">
              "Gerenciar membros" é herdado da versão antiga: por compatibilidade ele também libera
              criar/purgar canais e abrir a entrada pública. Marque os outros dois bits para ver o
              alcance explícito, ou remova "Gerenciar" se o bot só precisa expulsar membros.
            </Notice>
          )}
        </Card>
  )
}
