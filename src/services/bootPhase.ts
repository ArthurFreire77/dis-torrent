export type BootPhase = 'loading' | 'create' | 'lock' | 'app'

export interface VaultStatusView {
  has_identity: boolean
  has_vault: boolean
  /** Tem identidade, mas o keyring sumiu e não há cofre por senha. */
  locked?: boolean
}

/**
 * Decide em que tela de entrada o app abre.
 *
 * POR QUE existe: desktop e celular tinham a mesma escada aninhada de
 * `identityGet` → `vaultStatus` → `vaultUnlock` escrita duas vezes, e os
 * caminhos de erro divergiam — o desktop ia para `app` sem identidade
 * carregada, o celular ia para `create`. `app` sem identidade é o estado que
 * deixa a interface vazia (sem perfil, sem nome), então a decisão virou uma
 * regra pura, testável, usada pelos dois shells.
 */
export function resolveBootPhase(input: {
  identity: unknown | null
  vault: VaultStatusView | null
  unlocked: unknown | null
}): BootPhase {
  if (input.identity) return 'app'
  if (!input.vault) return 'create'
  if (!input.vault.has_identity) return 'create'
  if (input.vault.has_vault) return input.unlocked ? 'app' : 'lock'
  // Identidade sem segredo recuperável (pasta copiada para outro PC sem o
  // keyring): a tela de bloqueio é o único caminho honesto — ela explica que
  // é preciso importar um .stormvault com senha. "Criar conta" mentiria
  // porque `identity_create` recusa com identidade já existente.
  if (input.vault.locked) return 'lock'
  return input.identity ? 'app' : 'create'
}
