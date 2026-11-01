// Grupos que EU apaguei (só para mim) — "lixeira" persistente.
//
// PROBLEMA QUE ISTO RESOLVE: apagar "só para mim" removia a conversa local, mas
// qualquer mensagem nova de um amigo no mesmo `conv_id` passava pelo lazy-join
// do `handle_frame` e **recriava o grupo** (era o "apago e depois de um tempo
// ele reaparece"). O `GroupCreated` também reinseria o roster.
//
// Aqui fica a lista de `conv_id` que o usuário mandou apagar. O lazy-join e o
// sync de grupo consultam antes de recriar; ao REENTRAR explicitamente no grupo
// (aceitar convite novo / receber mensagem direcionada com `GroupCreated` de
// quem me readicionou), a entrada é removida.
//
// Guardado no kv do SQLite, não em memória: reiniciar o app não pode ressuscitar
// o grupo apagado.

use crate::storage::Store;
use crate::Result;

const KEY: &str = "groups.dismissed";

fn ler(store: &Store) -> Vec<String> {
    store
        .kv_get(KEY)
        .map(|raw| {
            raw.split('\n')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn gravar(store: &Store, lista: &[String]) -> Result<()> {
    // Teto: um usuário ativo não acumula milhares; se acumular, mantém os
    // mais recentes (o vetor é gravado na ordem em que foi montado).
    let inicio = lista.len().saturating_sub(256);
    store.kv_set(KEY, &lista[inicio..].join("\n"))
}

/// Marca o grupo como apagado por mim.
pub fn dismiss(store: &Store, conv_id: &str) -> Result<()> {
    if conv_id.trim().is_empty() {
        return Ok(());
    }
    let mut lista = ler(store);
    if lista.iter().any(|c| c == conv_id) {
        return Ok(());
    }
    lista.push(conv_id.to_string());
    gravar(store, &lista)
}

/// Eu apaguei este grupo? (bloqueia recriação automática)
pub fn is_dismissed(store: &Store, conv_id: &str) -> bool {
    if conv_id.trim().is_empty() {
        return false;
    }
    ler(store).iter().any(|c| c == conv_id)
}

/// Voltei ao grupo de propósito: para de bloquear a recriação.
pub fn restore(store: &Store, conv_id: &str) -> Result<()> {
    let mut lista = ler(store);
    let antes = lista.len();
    lista.retain(|c| c != conv_id);
    if lista.len() == antes {
        return Ok(());
    }
    gravar(store, &lista)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("d.db")).unwrap();
        (s, dir)
    }

    #[test]
    fn apagar_marca_e_sobrevive_ao_reinicio() {
        let (s, _d) = store();
        assert!(!is_dismissed(&s, "conv-1"));
        dismiss(&s, "conv-1").unwrap();
        assert!(is_dismissed(&s, "conv-1"));
        // Outra instância lendo o MESMO banco (reinício do app).
        let s2 = Store::open(&_d.path().join("d.db")).unwrap();
        assert!(
            is_dismissed(&s2, "conv-1"),
            "reiniciar o app não pode ressuscitar o grupo"
        );
    }

    #[test]
    fn reentrar_limpa_o_bloqueio() {
        let (s, _d) = store();
        dismiss(&s, "conv-1").unwrap();
        restore(&s, "conv-1").unwrap();
        assert!(!is_dismissed(&s, "conv-1"));
    }

    #[test]
    fn id_vazio_nunca_bloqueia_nada() {
        let (s, _d) = store();
        dismiss(&s, "").unwrap();
        assert!(!is_dismissed(&s, ""));
    }

    #[test]
    fn lista_respeita_o_teto_sem_perder_o_recente() {
        let (s, _d) = store();
        for i in 0..300 {
            dismiss(&s, &format!("conv-{i}")).unwrap();
        }
        assert!(is_dismissed(&s, "conv-299"), "o mais novo tem de ficar");
        assert!(!is_dismissed(&s, "conv-0"), "os mais antigos saem do teto");
    }
}
