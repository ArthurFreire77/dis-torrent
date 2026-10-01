//! Uma sessão recusada não pode deixar ninguém preso no microfone.
//!
//! ARQUIVO PRÓPRIO de propósito: o hub de áudio é um singleton do PROCESSO e o
//! `subscriber_count()` é global. Noutro arquivo de teste o runner (paralelo)
//! poderia estar contando a assinatura de outra sessão ao mesmo tempo, e a
//! asserção viraria flakiness em vez de prova.

use forge_core::net::media_voice::{VoiceMedia, audio};

#[test]
fn sdp_recusado_nao_deixa_microfone_assinado() {
    let m = VoiceMedia::new().expect("VoiceMedia::new");

    let antes = audio::hub().subscriber_count();
    assert!(
        m.handle_offer("call-ruim", "peer-x", "isto-nao-e-um-sdp").is_err(),
        "SDP invalido tem de ser recusado"
    );
    assert_eq!(
        audio::hub().subscriber_count(),
        antes,
        "negociação recusada deixou assinatura de microfone pendurada"
    );
    assert!(m.stats("call-ruim").is_none(), "sessao nao deve existir");
}
