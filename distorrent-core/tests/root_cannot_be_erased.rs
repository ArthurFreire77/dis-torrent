//! O ataque que o dono apontou: "um cara pode só apagar essa parte".
//!
//! Se alguém remover a raiz de confiança do código, o app NÃO pode passar a
//! aceitar qualquer coisa, nem degradar para "todo mundo é confiável". Tem de
//! ficar evidentemente quebrado: sem chave pré-compilada, `verification_available`
//! é `false`, nenhum manifesto é aceito e o atualizador recusa oferecer update.
//!
//! Este teste também trava a ausência de QUALQUER override em runtime — a outra
//! forma de "apagar" a verificação sem tocar na constante.

use distorrent_core::release::store::ReleaseTrust;
use distorrent_core::release::trust::{bootstrap_trust_set, parse_trust_set};

#[test]
fn sem_raiz_embutida_a_verificacao_fica_indisponivel_e_nada_e_aceito() {
    // Simula o build sabotado: conjunto ausente.
    let sem_chaves = ReleaseTrust::empty("sem chaves de confiança embutidas");
    assert!(!sem_chaves.verification_available());
    assert!(sem_chaves.trust().is_none());
    assert!(sem_chaves.latest_verified().is_none());
    // E o motivo é explícito, não silencioso.
    assert!(sem_chaves.unavailable_reason().is_some());
}

#[test]
fn a_raiz_de_confianca_nao_pode_ser_trocada_por_variavel_de_ambiente() {
    // `bootstrap_trust_set` lê SÓ a constante compilada. Setar a variável que
    // existia antes (DISTORRENT_TRUST_SET) não muda nada.
    let antes = bootstrap_trust_set().expect("raiz embutida");
    std::env::set_var(
        "DISTORRENT_TRUST_SET",
        "9|2|aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,cccccccccccccccc:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    );
    let depois = bootstrap_trust_set().expect("raiz embutida");
    std::env::remove_var("DISTORRENT_TRUST_SET");
    assert_eq!(antes, depois, "variável de ambiente não pode trocar a raiz");
    assert_eq!(depois.epoch, 1);
    assert_eq!(depois.keys.len(), 3);
}

#[test]
fn chave_de_atacante_nao_entra_na_raiz_embutida() {
    let set = bootstrap_trust_set().unwrap();
    let atacante = crate::chave_de_teste();
    let id = distorrent_core::release::TrustedKey::from_pubkey_hex(&atacante)
        .unwrap()
        .key_id;
    assert!(
        !set.has_key(&id),
        "chave gerada em runtime jamais está no conjunto compilado"
    );
}

#[test]
fn conjunto_sabotado_com_limiar_1_e_recusado_no_parse() {
    // Outra forma de "apagar a verificação": baixar o limiar para 1 no arquivo.
    let um =
        "1|1|00214a4965a6f495:c340a475ea903c4e789af3eae43722524cf9a014f5a9245129cd5dec0125c70b";
    assert!(parse_trust_set(um).is_err(), "limiar 1 nunca é aceito");
    let dois =
        "1|2|00214a4965a6f495:c340a475ea903c4e789af3eae43722524cf9a014f5a9245129cd5dec0125c70b";
    assert!(
        parse_trust_set(dois).is_err(),
        "2-de-2 com uma chave só não fecha"
    );
}

/// Chave pública descartável, gerada a cada execução.
fn chave_de_teste() -> String {
    distorrent_core::identity::Keypair::generate().public_hex()
}
