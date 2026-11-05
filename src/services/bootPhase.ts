export type BootPhase = 'loading' | 'create' | 'lock' | 'app'

export interface VaultStatusView {
  has_identity: boolean
  has_vault: boolean
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
  // Sem resposta de cofre não dá para afirmar nada: pede para criar é o único
  // caminho que não inventa um estado (nem "destrave" nem "entrou").
  if (!input.vault) return 'create'
  if (!input.vault.has_identity) return 'create'
  if (input.vault.has_vault) return input.unlocked ? 'app' : 'lock'
  // Tem identidade mas nenhum cofre: a chave está no armazenamento local, então
  // reler a identidade é o caminho certo — nunca abrir o app sem ela.
  return input.identity ? 'app' : 'create'
}
