// ELEIÇÃO DE SESSÃO: o que decide se uma sessão nova substitui a que já está
// `Online`. Era aqui que a instabilidade nascia — um dial repetido do MESMO
// lado substituía a sessão saudável, abortava a writer e descartava os frames
// que já estavam na fila (mensagem e `Ack` em voo sumiam, o balão voltava para
// o relógio e o log mostrava "peer ONLINE" de novo em segundos).
use super::nova_sessao_substitui;

#[test]
fn dial_repetido_do_mesmo_lado_nao_derruba_sessao() {
    // Eu já tinha sessão direta que EU iniciei; um segundo dial meu (maintain +
    // discovery) chega com a mesma direção. Nada pode ser trocado.
    assert!(!nova_sessao_substitui(
        false, true, // atual: direta, iniciada por mim
        false, true, // nova:  direta, iniciada por mim
        true, // prefiro outbound (fp menor) — irrelevante aqui
    ));
    // Mesmo caso do outro lado (que também não troca a que recebeu).
    assert!(!nova_sessao_substitui(true, false, true, false, false));
}

#[test]
fn relay_repetido_tambem_nao_derruba_sessao_relay() {
    // No relay o maintain rediala sozinho com frequência; trocar a sessão a
    // cada tentativa jogava fora o `Ack` que estava voltando.
    assert!(!nova_sessao_substitui(true, true, true, true, true));
    assert!(!nova_sessao_substitui(true, false, true, false, true));
}

#[test]
fn direta_sempre_vence_relay() {
    // Sessão atual no relay (mesmo iniciada por mim): a direta nova entra.
    assert!(nova_sessao_substitui(true, true, false, false, false));
    assert!(nova_sessao_substitui(true, false, false, true, true));
    // O contrário nunca: uma relay nova não pode derrubar a direta boa.
    assert!(!nova_sessao_substitui(false, true, true, false, true));
    assert!(!nova_sessao_substitui(false, false, true, true, false));
}

/// DIAL CRUZADO: as duas pontas abriram sessão (uma iniciou, a outra recebeu).
/// O desempate é o fingerprint, e as duas pontas precisam escolher a MESMA
/// sessão — senão cada lado derruba a do outro em loop.
#[test]
fn dial_cruzado_as_duas_pontas_escolhem_a_mesma_sessao() {
    // fp MENOR (prefiro outbound): sessão recebida na mão, dial própria chega
    // → troca para a própria.
    assert!(nova_sessao_substitui(false, false, false, true, true));
    // fp MAIOR (não prefiro outbound): está com a própria dial, chega a
    // recebida → também troca.
    assert!(nova_sessao_substitui(false, true, false, false, false));
    // E os contrários: a sessão preferida já está no ar, não troca.
    assert!(!nova_sessao_substitui(false, true, false, false, true));
    assert!(!nova_sessao_substitui(false, false, false, true, false));
}

#[test]
fn direta_cruzada_troca_uma_vez_e_para() {
    // Depois da troca a sessão registrada já tem a direção preferida: uma
    // terceira sessão igual não substitui de novo (sem pingue-pongue).
    assert!(nova_sessao_substitui(false, false, false, true, true));
    assert!(!nova_sessao_substitui(false, true, false, true, true));
}

/// A relay só cede para a direta — nunca troca de relay para relay novo de
/// outra direção no meio de um cruzamento (isso descartaria o `Ack` que ia
/// voltar). O upgrade para direta é o único movimento permitido.
#[test]
fn relay_cruzada_espera_a_direta() {
    assert!(!nova_sessao_substitui(true, true, true, false, true));
    assert!(!nova_sessao_substitui(true, false, true, true, false));
    assert!(nova_sessao_substitui(true, true, false, true, true));
}
