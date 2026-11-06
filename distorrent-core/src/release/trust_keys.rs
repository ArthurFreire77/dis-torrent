//! Arquivo de chaves públicas de confiança incorporadas ao cliente.
//!
//! ESTE ARQUIVO NÃO CONTÉM (E NUNCA PODE CONTER) CHAVE PRIVADA. Ele é o único
//! lugar do build que carrega a raiz de confiança. As chaves privadas
//! correspondentes vivem FORA do repositório (a cerimônia grava em
//! `~/.distorrent-release-keys`, uma por mídia offline).
//!
//! Formato: `epoch|threshold|key_id:pubkey_hex,...` (key_id = blake3(pubkey)[..8]).
//!
//! Se esta constante ficar vazia, `bootstrap_trust_set()` devolve erro e o
//! cliente trata TODA release como não verificada (fail-closed). Não existe
//! variável de ambiente, arquivo de configuração nem comando que troque este
//! valor em runtime: a raiz de confiança é compilada. Qualquer override seria o
//! botão que um atacante usaria para trocar a autoridade.

/// Conjunto 1 (epoch 1), limiar 2 de 3.
pub const TRUST_SET_BOOTSTRAP: &str = "1|2|00214a4965a6f495:c340a475ea903c4e789af3eae43722524cf9a014f5a9245129cd5dec0125c70b,06aa2b141daf1729:791a063507b326d6524d614ec91ab63bb80e62513a554841b4ea7f0b09fe1c1b,e522a4686689acb8:7f3511ab705bb71f56f6e9b369def5e90e015f860ee05b153adf8d3b0c51e897";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release::trust::{bootstrap_trust_set, parse_trust_set};

    #[test]
    fn conjunto_embutido_e_valido_e_tem_limiar_2_de_3() {
        let set = bootstrap_trust_set().expect("a raiz de confiança precisa existir");
        assert_eq!(set.epoch, 1);
        assert_eq!(set.threshold, 2);
        assert_eq!(set.keys.len(), 3);
        // Todo key_id tem de derivar da pubkey (não é texto solto).
        for k in &set.keys {
            let derived = crate::release::TrustedKey::from_pubkey_hex(&k.pubkey_hex).unwrap();
            assert_eq!(derived.key_id, k.key_id);
        }
    }

    #[test]
    fn a_constante_nao_contem_segredo() {
        // 32 bytes de segredo em hex = 64 caracteres hex contínuos; a linha da
        // cerimônia tem pubkeys (64 hex) mas sempre precedidas de `key_id:`.
        assert!(!TRUST_SET_BOOTSTRAP.contains("PRIVATE"));
        // Nenhuma palavra-chave de segredo.
        let low = TRUST_SET_BOOTSTRAP.to_ascii_lowercase();
        assert!(!low.contains("secret"));
        assert!(!low.contains("signing"));
    }

    #[test]
    fn parse_rejeita_limiar_1() {
        assert!(parse_trust_set(
            "1|1|00214a4965a6f495:c340a475ea903c4e789af3eae43722524cf9a014f5a9245129cd5dec0125c70b"
        )
        .is_err());
    }
}
