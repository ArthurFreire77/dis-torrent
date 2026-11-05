use crate::storage::Store;
use crate::Result;

const KEY: &str = "groups.dismissed";

/// Cada linha é `conv_id|dono`; linha sem `|` é entrada antiga (dono desconhecido).
fn ler(store: &Store) -> Vec<(String, String)> {
    store
        .kv_get(KEY)
        .map(|raw| {
            raw.split('\n')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|linha| match linha.split_once('|') {
                    Some((conv, dono)) => (conv.to_string(), dono.to_string()),
                    None => (linha.to_string(), String::new()),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn gravar(store: &Store, lista: &[(String, String)]) -> Result<()> {
    let inicio = lista.len().saturating_sub(256);
    let texto = lista[inicio..]
        .iter()
        .map(|(conv, dono)| format!("{conv}|{dono}"))
        .collect::<Vec<_>>()
        .join("\n");
    store.kv_set(KEY, &texto)
}

/// Dispensa o grupo sem saber quem o criou (entradas antigas).
pub fn dismiss(store: &Store, conv_id: &str) -> Result<()> {
    dismiss_owned(store, conv_id, "")
}

/// Dispensa e guarda o criador: depois de sair a conversa é apagada, então só
/// este registro permite saber de quem aceitar uma readição de propósito.
pub fn dismiss_owned(store: &Store, conv_id: &str, owner_fp: &str) -> Result<()> {
    if conv_id.trim().is_empty() {
        return Ok(());
    }
    let mut lista = ler(store);
    if let Some((_, dono)) = lista.iter_mut().find(|(c, _)| c == conv_id) {
        if !owner_fp.is_empty() && dono.is_empty() {
            *dono = owner_fp.to_string();
            gravar(store, &lista)?;
        }
        return Ok(());
    }
    lista.push((conv_id.to_string(), owner_fp.to_string()));
    gravar(store, &lista)
}

pub fn is_dismissed(store: &Store, conv_id: &str) -> bool {
    if conv_id.trim().is_empty() {
        return false;
    }
    ler(store).iter().any(|(c, _)| c == conv_id)
}

/// Criador gravado no momento em que o grupo foi dispensado, se conhecido.
pub fn owner_of(store: &Store, conv_id: &str) -> Option<String> {
    if conv_id.trim().is_empty() {
        return None;
    }
    ler(store)
        .into_iter()
        .find(|(c, _)| c == conv_id)
        .map(|(_, dono)| dono)
        .filter(|dono| !dono.is_empty())
}

pub fn restore(store: &Store, conv_id: &str) -> Result<()> {
    let mut lista = ler(store);
    let antes = lista.len();
    lista.retain(|(c, _)| c != conv_id);
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

    #[test]
    fn guarda_o_criador_para_reconhecer_readicao() {
        let (s, _d) = store();
        assert_eq!(owner_of(&s, "conv-1"), None);
        dismiss_owned(&s, "conv-1", "criador-fp").unwrap();
        assert_eq!(owner_of(&s, "conv-1").as_deref(), Some("criador-fp"));
        let s2 = Store::open(&_d.path().join("d.db")).unwrap();
        assert_eq!(
            owner_of(&s2, "conv-1").as_deref(),
            Some("criador-fp"),
            "o criador tem de sobreviver ao reinício junto com o bloqueio"
        );
    }

    #[test]
    fn dispensar_de_novo_preenche_o_criador_que_faltava() {
        let (s, _d) = store();
        dismiss(&s, "conv-1").unwrap();
        assert_eq!(owner_of(&s, "conv-1"), None);
        dismiss_owned(&s, "conv-1", "criador-fp").unwrap();
        assert!(is_dismissed(&s, "conv-1"), "não pode duplicar a entrada");
        assert_eq!(owner_of(&s, "conv-1").as_deref(), Some("criador-fp"));
    }
}
