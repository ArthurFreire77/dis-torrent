use super::nova_sessao_substitui;

#[test]
fn dial_repetido_do_mesmo_lado_nao_derruba_sessao() {
    assert!(!nova_sessao_substitui(false, true, false, true, true,));
    assert!(!nova_sessao_substitui(true, false, true, false, false));
}

#[test]
fn relay_repetido_tambem_nao_derruba_sessao_relay() {
    assert!(!nova_sessao_substitui(true, true, true, true, true));
    assert!(!nova_sessao_substitui(true, false, true, false, true));
}

#[test]
fn direta_sempre_vence_relay() {
    assert!(nova_sessao_substitui(true, true, false, false, false));
    assert!(nova_sessao_substitui(true, false, false, true, true));
    assert!(!nova_sessao_substitui(false, true, true, false, true));
    assert!(!nova_sessao_substitui(false, false, true, true, false));
}

#[test]
fn dial_cruzado_as_duas_pontas_escolhem_a_mesma_sessao() {
    assert!(nova_sessao_substitui(false, false, false, true, true));
    assert!(nova_sessao_substitui(false, true, false, false, false));
    assert!(!nova_sessao_substitui(false, true, false, false, true));
    assert!(!nova_sessao_substitui(false, false, false, true, false));
}

#[test]
fn direta_cruzada_troca_uma_vez_e_para() {
    assert!(nova_sessao_substitui(false, false, false, true, true));
    assert!(!nova_sessao_substitui(false, true, false, true, true));
}

#[test]
fn relay_cruzada_espera_a_direta() {
    assert!(!nova_sessao_substitui(true, true, true, false, true));
    assert!(!nova_sessao_substitui(true, false, true, true, false));
    assert!(nova_sessao_substitui(true, true, false, true, true));
}
