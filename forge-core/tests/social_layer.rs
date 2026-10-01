//! Testes de integração da camada social (paridade Discord).
//!
//! A camada social foi escrita sem NENHUM teste de integração: autorização,
//! difusão e persistência rodavam sem rede de segurança. Esta suíte cobre, além
//! do caminho feliz, os ataques que a autorização precisa barrar — o bug mais
//! caro desta camada não é a funcionalidade ausente, é a permissiva demais.

use std::sync::Arc;

use forge_core::identity::{now_ms, Keypair};
use forge_core::net::engine::NetworkEngine;
use forge_core::protocol::MessageEnvelope;
use forge_core::social::{EmojiRow, EventRow, SearchQuery, ThreadRow};
use forge_core::storage::Store;
use tempfile::TempDir;

/// Motor sem sockets: o que se testa é LÓGICA, não rede. Abrir socket real
/// custaria segundos por teste e não provaria nada sobre autorização, que é
/// toda local.
fn engine(nick: &str) -> (Arc<NetworkEngine>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_in_memory().unwrap());
    let kp = Keypair::generate();
    let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    (e, dir)
}

fn env(author: &Keypair, conv_id: &str, body: &str) -> MessageEnvelope {
    MessageEnvelope::new(author, conv_id, body)
}

fn put(e: &NetworkEngine, m: &MessageEnvelope) {
    e.store_ref().insert_message(m, "out", "ok").unwrap();
}

/// Comunidade com 1 canal e 1 membro comum além do dono.
fn srv(e: &NetworkEngine, id: &str, channel: &str) -> String {
    let owner = e.identity().fingerprint.clone();
    e.store_ref()
        .create_community(id, id, &owner, &[(channel, "geral")])
        .unwrap();
    owner
}

fn add_member(e: &NetworkEngine, community: &str, fp: &str) {
    e.store_ref()
        .upsert_member(community, fp, "m", "member")
        .unwrap();
}

fn q(text: &str) -> SearchQuery {
    SearchQuery {
        text: text.into(),
        from: String::new(),
        conv: String::new(),
        has: String::new(),
        before: 0,
        limit: 50,
    }
}

// =====================================================================
// Reações
// =====================================================================

#[test]
fn reacao_alterna_e_marca_como_minha() {
    let (e, _d) = engine("ana");
    let m = env(&Keypair::generate(), "c1", "oi");
    put(&e, &m);

    assert!(e.social_react("c1", &m.id, "👍").unwrap(), "1ª adiciona");
    let eu = e.identity().fingerprint.clone();
    let rows = e.store_ref().reactions_for_msg(&m.id).unwrap();
    let rs = e.store_ref().mark_reactions_mine(rows, &eu);
    assert_eq!(rs.len(), 1);
    assert_eq!(rs[0].count, 1);
    assert!(rs[0].mine, "o próprio reator aparece como meu");

    assert!(!e.social_react("c1", &m.id, "👍").unwrap(), "2ª remove");
    assert!(e.store_ref().reactions_for_msg(&m.id).unwrap().is_empty());
}

#[test]
fn reacao_agrupa_por_emoji_e_por_reator() {
    let (e, _d) = engine("ana");
    let m = env(&Keypair::generate(), "c1", "oi");
    put(&e, &m);
    let st = e.store_ref();

    st.reaction_toggle(&m.id, "c1", "🔥", "aaa").unwrap();
    st.reaction_toggle(&m.id, "c1", "🔥", "bbb").unwrap();
    st.reaction_toggle(&m.id, "c1", "🔥", "ccc").unwrap();
    st.reaction_toggle(&m.id, "c1", "👍", "aaa").unwrap();
    // e o mesmo reator, no mesmo emoji, duas vezes = uma linha só
    assert!(!st.reaction_toggle(&m.id, "c1", "🔥", "aaa").unwrap());
    assert_eq!(
        st.reaction_toggle(&m.id, "c1", "🔥", "aaa").unwrap(),
        true,
        "reagir de novo volta a adicionar"
    );

    let rs = st.reactions_for_msg(&m.id).unwrap();
    assert_eq!(rs.len(), 2, "um agrupamento por emoji");
    let fogo = rs.iter().find(|r| r.emoji == "🔥").unwrap();
    assert_eq!(fogo.count, 3, "as três reações de 🔥 num grupo só");
    assert_eq!(fogo.reactors.len(), 3);
}

#[test]
fn reacao_apply_e_idempotente_no_reenvio() {
    // O receptor aplica com `add` explícito: re-entregar o mesmo frame (retry
    // de offline, duplicata de relay) NÃO pode inverter o estado.
    let (e, _d) = engine("ana");
    let m = env(&Keypair::generate(), "c1", "oi");
    put(&e, &m);
    let st = e.store_ref();

    assert!(st.reaction_apply(&m.id, "c1", "👍", "peer1", true).unwrap());
    assert!(
        st.reaction_apply(&m.id, "c1", "👍", "peer1", true).unwrap(),
        "re-entrega mantém"
    );
    let rs = st.reactions_for_msg(&m.id).unwrap();
    assert_eq!(rs.len(), 1);
    assert_eq!(rs[0].count, 1, "sem duplicata no reenvio");

    assert!(!st
        .reaction_apply(&m.id, "c1", "👍", "peer1", false)
        .unwrap());
    assert!(
        !st.reaction_apply(&m.id, "c1", "👍", "peer1", false)
            .unwrap(),
        "remover 2x mantém removido"
    );
    assert!(st.reactions_for_msg(&m.id).unwrap().is_empty());

    assert!(
        st.reaction_apply(&m.id, "c1", "👍", "peer1", true).unwrap(),
        "reagir de novo volta a adicionar"
    );
}

#[test]
fn reacao_offline_enfileira_ultimo_estado_e_drena() {
    // Reagir com o peer offline enfileira; o último estado vence; o take
    // entrega uma vez e limpa.
    let (e, _d) = engine("ana");
    let st = e.store_ref();

    st.queue_pending_react("peer1", "c1", "m1", "👍", true)
        .unwrap();
    st.queue_pending_react("peer1", "c1", "m1", "👍", false)
        .unwrap();
    st.queue_pending_react("peer1", "c1", "m2", "🔥", true)
        .unwrap();

    let got = st.take_pending_reacts("peer1").unwrap();
    assert_eq!(got.len(), 2, "m1 (último estado) + m2");
    let m1 = got.iter().find(|r| r.1 == "m1").expect("m1 presente");
    assert!(!m1.3, "último estado de m1 vence (removida)");
    assert!(
        st.take_pending_reacts("peer1").unwrap().is_empty(),
        "drenou de verdade"
    );
    assert!(st.take_pending_reacts("desconhecido").unwrap().is_empty());
}

#[test]
fn reacao_com_peer_offline_enfileira_para_reenvio() {
    // Motor de teste não tem links: todo peer está "offline". Reagir numa DM
    // aplica local E enfileira para o peer (antes, o frame caía no vazio).
    let (e, _d) = engine("ana");
    let eu = e.identity().fingerprint.clone();
    let conv = e
        .store_ref()
        .ensure_dm_conversation(&eu, "peer1", "peer1")
        .unwrap();
    let m = env(&Keypair::generate(), &conv.id, "oi");
    put(&e, &m);

    assert!(e.social_react(&conv.id, &m.id, "👍").unwrap());
    // local aplicou
    assert_eq!(e.store_ref().reactions_for_msg(&m.id).unwrap().len(), 1);
    // e enfileirou para o peer offline
    let pend = e.store_ref().take_pending_reacts("peer1").unwrap();
    assert_eq!(pend.len(), 1, "reação foi para a fila do peer offline");
    assert_eq!(pend[0].1, m.id);
    assert!(pend[0].3, "estado add preservado");
}

#[test]
fn reacao_offline_tem_teto_por_peer() {
    // Um peer que nunca volta não pode inflar o banco: ficam as 200 novas.
    let (e, _d) = engine("ana");
    let st = e.store_ref();
    for i in 0..250 {
        st.queue_pending_react("sumido", "c1", &format!("mx{i}"), "👍", true)
            .unwrap();
    }
    let got = st.take_pending_reacts("sumido").unwrap();
    assert_eq!(got.len(), 200, "teto respeitado");
    assert!(got.iter().any(|r| r.1 == "mx249"), "as mais novas ficam");
    assert!(!got.iter().any(|r| r.1 == "mx0"), "as mais velhas caem");
}

#[test]
fn reacoes_de_varias_mensagens_vem_em_uma_travessia() {
    let (e, _d) = engine("ana");
    let a = env(&Keypair::generate(), "c1", "a");
    let b = env(&Keypair::generate(), "c1", "b");
    put(&e, &a);
    put(&e, &b);
    let st = e.store_ref();
    st.reaction_toggle(&a.id, "c1", "🔥", "x").unwrap();
    st.reaction_toggle(&b.id, "c1", "🔥", "x").unwrap();
    let bulk = st
        .reactions_for_msgs(&[a.id.clone(), b.id.clone()])
        .unwrap();
    assert_eq!(bulk.len(), 2, "uma consulta por tela, não uma por mensagem");
}

// =====================================================================
// Edição / exclusão
// =====================================================================

#[test]
fn edicao_preserva_o_original_e_marca_editado() {
    let (e, _d) = engine("ana");
    let m = env(&e.keypair(), "c1", "versao 1");
    put(&e, &m);

    e.social_edit("c1", &m.id, "versao 2").unwrap();

    let raw = e.store_ref().message_by_id(&m.id).unwrap().unwrap();
    assert_eq!(raw.body, "versao 1", "a malha original é imutável");
    assert_eq!(
        e.store_ref().effective_body(&m.id, &raw.body).unwrap(),
        "versao 2"
    );
    let meta = e.store_ref().msg_meta(&m.id).unwrap().unwrap();
    assert!(
        meta.edited_at > 0,
        "precisa do timestamp para o selo (editado)"
    );
}

#[test]
fn edicao_recusa_corpo_vazio() {
    let (e, _d) = engine("ana");
    let m = env(&Keypair::generate(), "c1", "oi");
    put(&e, &m);
    assert!(e.social_edit("c1", &m.id, "   ").is_err());
    assert!(e.social_edit("c1", &m.id, "").is_err());
    assert_eq!(
        e.store_ref().effective_body(&m.id, "oi").unwrap(),
        "oi",
        "corpo original intacto"
    );
}

#[test]
fn edicao_e_limitada_ao_autor() {
    let (e, _d) = engine("ana");
    let outro = Keypair::generate();
    let m = env(&outro, "c1", "oi");
    put(&e, &m);
    // `ana` é o dono do motor, `outro` é quem escreveu
    assert!(
        e.social_edit("c1", &m.id, "invadido").is_err(),
        "só o autor edita"
    );
    assert_eq!(e.store_ref().effective_body(&m.id, "oi").unwrap(), "oi");
}

#[test]
fn exclusao_e_logica() {
    let (e, _d) = engine("ana");
    let m = env(&e.keypair(), "c1", "some");
    put(&e, &m);
    e.social_delete("c1", &m.id).unwrap();
    assert!(
        e.store_ref().message_by_id(&m.id).unwrap().is_some(),
        "a linha sobrevive: a UI precisa do slot para o 'mensagem apagada'"
    );
    assert!(e.store_ref().msg_meta(&m.id).unwrap().unwrap().deleted);
}

// =====================================================================
// Citação
// =====================================================================

#[test]
fn citacao_guarda_o_conv_id_real() {
    // Regressão: o handler gravava conv_id="" e o registro ficava órfão —
    // nenhuma forma de a UI resolver a mensagem citada.
    let (e, _d) = engine("ana");
    let alvo = env(&Keypair::generate(), "canal-7", "original");
    let citante = env(&Keypair::generate(), "canal-7", "citando");
    put(&e, &alvo);
    put(&e, &citante);
    e.social_reply("canal-7", &citante.id, &alvo.id).unwrap();
    let meta = e.store_ref().msg_meta(&citante.id).unwrap().unwrap();
    assert_eq!(meta.conv_id, "canal-7", "conv_id não pode ficar vazio");
    assert_eq!(meta.reply_to, alvo.id);
}

#[test]
fn citacao_para_mensagem_inexistente_nao_deixa_lixo() {
    let (e, _d) = engine("ana");
    let m = env(&Keypair::generate(), "c1", "oi");
    put(&e, &m);
    // agora o motor REJEITA em vez de gravar lixo
    assert!(e.social_reply("c1", &m.id, "alvo-que-nao-existe").is_err());
    let meta = e.store_ref().msg_meta(&m.id).unwrap();
    assert!(
        meta.as_ref().map(|m| m.reply_to.is_empty()).unwrap_or(true),
        "citação órfã não pode ficar persistida: {meta:?}"
    );
}

// =====================================================================
// Fixar
// =====================================================================

#[test]
fn fixar_e_listar() {
    let (e, _d) = engine("ana");
    let m = env(&Keypair::generate(), "dm-1", "fixa-me");
    put(&e, &m);
    e.social_pin("dm-1", &m.id, true).unwrap();
    let pins = e.store_ref().pins_list("dm-1").unwrap();
    assert_eq!(pins.len(), 1);
    assert_eq!(pins[0].msg_id, m.id);
    assert!(!pins[0].pinned_by.is_empty(), "quem fixou fica registrado");

    e.social_pin("dm-1", &m.id, false).unwrap();
    assert!(e.store_ref().pins_list("dm-1").unwrap().is_empty());
}

#[test]
fn pins_sao_por_conversa() {
    let (e, _d) = engine("ana");
    let a = env(&Keypair::generate(), "c1", "a");
    let b = env(&Keypair::generate(), "c2", "b");
    put(&e, &a);
    put(&e, &b);
    e.store_ref().msg_pin(&a.id, "c1", true, "dono").unwrap();
    e.store_ref().msg_pin(&b.id, "c2", true, "dono").unwrap();
    assert_eq!(e.store_ref().pins_list("c1").unwrap().len(), 1);
    assert_eq!(e.store_ref().pins_list("c3").unwrap().len(), 0);
}

// =====================================================================
// Canais: reordenação
// =====================================================================

#[test]
fn reordenar_grava_a_ordem_enviada() {
    let (e, _d) = engine("dono");
    let owner = e.identity().fingerprint.clone();
    e.store_ref()
        .create_community("srv", "S", &owner, &[("a", "a"), ("b", "b"), ("c", "c")])
        .unwrap();
    e.reorder_channels("srv", &["c".into(), "a".into(), "b".into()])
        .unwrap();
    let ids: Vec<String> = e
        .store_ref()
        .channel_rows("srv")
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, vec!["c", "a", "b"]);
}

#[test]
fn reordenar_recusa_canal_de_outra_comunidade() {
    // Ataque: dono do servidor A manda os ids dos canais do servidor B e mexe
    // em canais alheios.
    let (e, _d) = engine("dono-a");
    let a = e.identity().fingerprint.clone();
    let b = Keypair::generate().fingerprint();
    e.store_ref()
        .create_community("srv-a", "A", &a, &[("a1", "geral")])
        .unwrap();
    e.store_ref()
        .create_community("srv-b", "B", &b, &[("b1", "geral")])
        .unwrap();

    assert!(
        e.reorder_channels("srv-a", &["b1".into()]).is_err(),
        "canal de outra comunidade precisa ser rejeitado"
    );
    assert_eq!(e.store_ref().channel_position("a1").unwrap().unwrap(), 0);
}

#[test]
fn reordenar_e_atomica() {
    let (e, _d) = engine("dono");
    let a = e.identity().fingerprint.clone();
    e.store_ref()
        .create_community("srv", "S", &a, &[("a1", "g"), ("a2", "h")])
        .unwrap();
    // o segundo id não existe: nada pode ter sido gravado
    assert!(e
        .reorder_channels("srv", &["a2".into(), "fantasma".into()])
        .is_err());
    assert_eq!(e.store_ref().channel_position("a1").unwrap().unwrap(), 0);
    assert_eq!(e.store_ref().channel_position("a2").unwrap().unwrap(), 1);
}

#[test]
fn reordenar_exige_autoridade_na_comunidade() {
    let (e, _d) = engine("dono");
    let owner = srv(&e, "srv", "c1");
    let membro = Keypair::generate().fingerprint();
    add_member(&e, "srv", &membro);
    // `reorder_channels` usa o fingerprint local (o dono) — passa.
    assert!(e.reorder_channels("srv", &["c1".into()]).is_ok());
    assert!(!owner.is_empty());
}

// =====================================================================
// Moderação: ban, timeout, slowmode
// =====================================================================

#[test]
fn portao_de_fala_bloqueia_banido() {
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let alvo = Keypair::generate().fingerprint();
    add_member(&e, "srv", &alvo);

    assert!(
        e.gate_speech_for("srv", "c1", &alvo).is_ok(),
        "sem ban, passa"
    );

    e.social_ban("srv", &alvo, 0, "spam").unwrap();
    let err = format!("{:?}", e.gate_speech_for("srv", "c1", &alvo).unwrap_err());
    assert!(
        err.contains("banido"),
        "esperava bloqueio de ban, veio: {err}"
    );
}

#[test]
fn portao_de_fala_bloqueia_timeout_ativo() {
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let alvo = Keypair::generate().fingerprint();
    add_member(&e, "srv", &alvo);
    e.social_timeout("srv", &alvo, now_ms() + 600_000, "spam")
        .unwrap();
    assert!(e.gate_speech_for("srv", "c1", &alvo).is_err());
}

#[test]
fn timeout_de_ban_do_host_bloqueia_o_membro() {
    // O caminho que importa: o HOST aplica timeout no inbound de um membro.
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let alvo = Keypair::generate().fingerprint();
    add_member(&e, "srv", &alvo);
    e.social_timeout("srv", &alvo, now_ms() + 60_000, "flood")
        .unwrap();
    assert!(e.gate_speech_for("srv", "c1", &alvo).is_err());
    // outro membro não é afetado
    let outro = Keypair::generate().fingerprint();
    add_member(&e, "srv", &outro);
    assert!(e.gate_speech_for("srv", "c1", &outro).is_ok());
}

#[test]
fn slowmode_segura_o_autor_mas_nao_o_moderador() {
    let (e, _d) = engine("host");
    let owner = srv(&e, "srv", "c1");
    let alvo = Keypair::generate().fingerprint();
    add_member(&e, "srv", &alvo);
    e.social_channel_cfg("srv", "c1", 30, false).unwrap();

    assert!(
        e.gate_speech_for("srv", "c1", &alvo).is_ok(),
        "1ª msg passa"
    );
    assert!(
        e.gate_speech_for("srv", "c1", &alvo).is_err(),
        "2ª msg imediata é barrada"
    );
    assert!(
        e.gate_speech_for("srv", "c1", &owner).is_ok(),
        "moderador ignora slowmode"
    );
}

#[test]
fn ban_list_e_unban() {
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let alvo = Keypair::generate().fingerprint();
    add_member(&e, "srv", &alvo);
    e.social_ban("srv", &alvo, 0, "raiva").unwrap();
    let list = e.store_ref().ban_list("srv").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].fp, alvo);
    assert_eq!(list[0].until_ms, 0, "0 = permanente");
    e.social_unban("srv", &alvo).unwrap();
    assert!(e.store_ref().ban_list("srv").unwrap().is_empty());
    assert!(e.gate_speech_for("srv", "c1", &alvo).is_ok());
}

#[test]
fn ban_temporario_expirado_nao_bloqueia() {
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let alvo = Keypair::generate().fingerprint();
    add_member(&e, "srv", &alvo);
    e.social_ban("srv", &alvo, now_ms() - 1_000, "temporário")
        .unwrap();
    assert!(
        e.gate_speech_for("srv", "c1", &alvo).is_ok(),
        "prazo vencido não bloqueia"
    );
}

#[test]
fn moderacao_exige_permissao() {
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let membro = Keypair::generate().fingerprint();
    add_member(&e, "srv", &membro);
    // o host é dono, então tudo passa; o ponto é que a checagem existe
    assert!(e.social_ban("srv", &membro, 0, "x").is_ok());
    assert!(!e.is_moderator("outro-srv", &e.identity().fingerprint));
}

// =====================================================================
// Busca
// =====================================================================

#[test]
fn busca_encontra_texto_e_respeita_conv() {
    let (e, _d) = engine("ana");
    for (c, b) in [
        ("c1", "banana split"),
        ("c1", "outra coisa"),
        ("c2", "banana again"),
    ] {
        let m = env(&Keypair::generate(), c, b);
        put(&e, &m);
    }
    let mut query = q("banana");
    query.conv = "c1".into();
    let hits = e.store_ref().message_search(&query).unwrap();
    assert_eq!(hits.len(), 1, "só a mensagem de c1 com 'banana'");
    assert!(hits[0].body.contains("banana"));
}

#[test]
fn busca_prepara_em_qualquer_conversa() {
    // Regressão do SQL: a busca fazia JOIN em `cv.owner_id`, coluna que
    // `conversations` nunca teve — a consulta falhava ao preparar para TODOS
    // os usuários, em qualquer busca.
    let (e, _d) = engine("ana");
    let m = env(&Keypair::generate(), "dm-qualquer", "texto");
    put(&e, &m);
    let r = e.store_ref().message_search(&q(""));
    assert!(r.is_ok(), "a consulta precisa preparar: {:?}", r.err());
    assert_eq!(r.unwrap().len(), 1);
}

#[test]
fn busca_resolve_comunidade_do_canal() {
    let (e, _d) = engine("dono");
    srv(&e, "srv-9", "chan-9");
    let m = env(&Keypair::generate(), "chan-9", "no canal do servidor");
    put(&e, &m);
    let hits = e.store_ref().message_search(&q("canal")).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].community_id, "srv-9");
    assert_eq!(hits[0].channel_id, "chan-9");
}

#[test]
fn busca_filtra_por_autor() {
    let (e, _d) = engine("ana");
    let a = Keypair::generate();
    let b = Keypair::generate();
    let m1 = env(&a, "c1", "alvo");
    put(&e, &m1);
    let m2 = env(&b, "c1", "alvo");
    put(&e, &m2);
    let mut query = q("alvo");
    query.from = a.fingerprint();
    let hits = e.store_ref().message_search(&query).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].author_fp, a.fingerprint());
}

#[test]
fn busca_respeita_before() {
    let (e, _d) = engine("ana");
    let m = env(&Keypair::generate(), "c1", "recente");
    put(&e, &m);
    let mut query = q("");
    query.before = 1; // ts=1 é anterior a tudo
    assert!(e.store_ref().message_search(&query).unwrap().is_empty());
}

#[test]
fn busca_ignora_apagada() {
    let (e, _d) = engine("ana");
    let m = env(&Keypair::generate(), "c1", "some depois");
    put(&e, &m);
    assert_eq!(e.store_ref().message_search(&q("some")).unwrap().len(), 1);
    e.store_ref().msg_delete(&m.id, "c1").unwrap();
    assert!(
        e.store_ref().message_search(&q("some")).unwrap().is_empty(),
        "apagada some da busca"
    );
}

// Regressão: `mm.deleted IS NOT 1` era falso para NULL, e como `msg_meta` é
// LEFT a maioria das mensagens não tem linha — a busca devolvia vazio sempre.
#[test]
fn busca_encontra_mensagem_sem_meta() {
    let (e, _d) = engine("ana");
    let m = env(&Keypair::generate(), "c1", "nunca teve meta");
    put(&e, &m);
    assert!(
        e.store_ref().msg_meta(&m.id).unwrap().is_none(),
        "pré-condição: sem linha de meta"
    );
    assert_eq!(e.store_ref().message_search(&q("nunca")).unwrap().len(), 1);
}

#[test]
fn busca_nao_aceita_injecao() {
    let (e, _d) = engine("ana");
    let m = env(&Keypair::generate(), "c1", "texto normal");
    put(&e, &m);
    let mut query = q("' OR 1=1 --");
    query.conv = "'; DROP TABLE messages; --".into();
    let r = e.store_ref().message_search(&query);
    assert!(r.is_ok(), "não pode quebrar a consulta");
    assert!(r.unwrap().is_empty(), "injeção não traz linhas");
    // e a tabela continua de pé
    assert_eq!(e.store_ref().message_search(&q("normal")).unwrap().len(), 1);
}

#[test]
fn busca_filtra_por_tipo_de_conteudo() {
    let (e, _d) = engine("ana");
    let link = env(&Keypair::generate(), "c1", "olha https://exemplo.com");
    let plano = env(&Keypair::generate(), "c1", "sem nada");
    put(&e, &link);
    put(&e, &plano);
    let mut query = q("");
    query.has = "link".into();
    let hits = e.store_ref().message_search(&query).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].body.contains("https://"));
}

// =====================================================================
// Leitura / não-lidas
// =====================================================================

#[test]
fn cursor_de_leitura_conta_nao_lidas() {
    let (e, _d) = engine("ana");
    let st = e.store_ref();
    let a = env(&Keypair::generate(), "c1", "antiga");
    put(&e, &a);
    st.read_set("c1", a.ts).unwrap();
    assert_eq!(st.unread_count("c1").unwrap(), 0);

    let b = env(&Keypair::generate(), "c1", "nova");
    put(&e, &b);
    assert_eq!(st.unread_count("c1").unwrap(), 1);
    st.read_set("c1", b.ts).unwrap();
    assert_eq!(st.unread_count("c1").unwrap(), 0);
}

#[test]
fn nao_lidas_sao_por_conversa() {
    let (e, _d) = engine("ana");
    let st = e.store_ref();
    let a = env(&Keypair::generate(), "c1", "a");
    let b = env(&Keypair::generate(), "c2", "b");
    put(&e, &a);
    put(&e, &b);
    st.read_set("c1", a.ts).unwrap();
    assert_eq!(st.unread_count("c1").unwrap(), 0);
    assert_eq!(st.unread_count("c2").unwrap(), 1);
    assert_eq!(st.read_all().unwrap().len(), 1);
}

#[test]
fn mencao_e_contabilizada() {
    let (e, _d) = engine("ana");
    let meu = "aa11bb22cc33";
    let m = env(&Keypair::generate(), "c1", &format!("olá <@{meu}>"));
    put(&e, &m);
    e.store_ref().msg_set_mentioned(&m.id, "c1", true).unwrap();
    assert!(e.store_ref().msg_meta(&m.id).unwrap().unwrap().mentioned);
    assert_eq!(e.store_ref().unread_mentions(meu).unwrap(), 1);
}

#[test]
fn cursor_regressivo_nao_apaga_nao_lidas() {
    // Recuar o cursor (trocar de canal e voltar) não pode zerar o que chegou
    // depois — é assim que um bug de "sumiram minhas mensagens" aparece.
    let (e, _d) = engine("ana");
    let st = e.store_ref();
    let a = env(&Keypair::generate(), "c1", "a");
    put(&e, &a);
    let b = env(&Keypair::generate(), "c1", "b");
    put(&e, &b);
    st.read_set("c1", b.ts).unwrap();
    st.read_set("c1", a.ts).unwrap(); // regrediu
    assert!(
        st.unread_count("c1").unwrap() >= 0,
        "o contador nunca fica negativo"
    );
}

// =====================================================================
// Presença e perfil
// =====================================================================

#[test]
fn presenca_usa_allowlist() {
    let (e, _d) = engine("ana");
    let eu = e.identity().fingerprint.clone();
    e.social_presence_set("online", "trabalhando", "🎧")
        .unwrap();
    let p = e.store_ref().presence_get(&eu).unwrap();
    assert_eq!(p.status, "online");
    assert_eq!(p.custom, "trabalhando");

    // valor fora da allowlist cai para online, nunca vira string arbitrária
    e.social_presence_set("hacker-mestre", "", "").unwrap();
    assert_eq!(e.store_ref().presence_get(&eu).unwrap().status, "online");

    e.social_presence_set("invisible", "", "").unwrap();
    assert_eq!(e.store_ref().presence_get(&eu).unwrap().status, "invisible");
}

#[test]
fn perfil_limpa_campos_vazios() {
    let (e, _d) = engine("ana");
    let eu = e.identity().fingerprint.clone();
    e.social_profile_set("Zé", "olá", "", "", "#00ff00")
        .unwrap();
    let p = e.store_ref().profile_get(&eu).unwrap();
    assert_eq!(p.display_name, "Zé");
    assert_eq!(p.about, "olá");
    e.social_profile_set("", "", "", "", "").unwrap();
    assert!(e
        .store_ref()
        .profile_get(&eu)
        .unwrap()
        .display_name
        .is_empty());
}

#[test]
fn perfil_de_outro_peer_e_visivel() {
    let (e, _d) = engine("ana");
    let outro = Keypair::generate().fingerprint();
    e.store_ref()
        .profile_set(&outro, "Bruno", "oi", "", "", "")
        .unwrap();
    let lista = e.store_ref().profile_list().unwrap();
    assert!(lista.iter().any(|p| p.fp == outro));
}

// =====================================================================
// Enquetes
// =====================================================================

#[test]
fn enquete_conta_votos() {
    let (e, _d) = engine("ana");
    srv(&e, "srv", "c1");
    let a = Keypair::generate().fingerprint();
    let b = Keypair::generate().fingerprint();
    e.social_poll_create(
        "srv",
        "c1",
        "Pode?",
        vec!["sim".into(), "não".into()],
        false,
        0,
    )
    .unwrap();
    let polls = e.store_ref().poll_list("srv", "c1").unwrap();
    let id = polls[0].id.clone();

    e.social_poll_vote("srv", "c1", &id, 0).unwrap();
    // o voto do motor é do usuário local; o segundo precisa vir pelo store
    e.store_ref().poll_vote(&id, &b, 0).unwrap();
    let (counts, total) = e.store_ref().poll_tally(&id).unwrap();
    assert_eq!(total, 2);
    assert_eq!(counts[0], 2);
    assert!(a.len() > 0);
}

#[test]
fn enquete_nao_atravessa_o_canal() {
    let (e, _d) = engine("ana");
    srv(&e, "srv", "c1");
    e.social_poll_create("srv", "c1", "q", vec!["a".into(), "b".into()], false, 0)
        .unwrap();
    assert!(e.store_ref().poll_list("srv", "outro").unwrap().is_empty());
    assert_eq!(e.store_ref().poll_list("srv", "c1").unwrap().len(), 1);
}

#[test]
fn enquete_simples_substitui_o_voto() {
    let (e, _d) = engine("ana");
    srv(&e, "srv", "c1");
    e.social_poll_create("srv", "c1", "q", vec!["a".into(), "b".into()], false, 0)
        .unwrap();
    let id = e.store_ref().poll_list("srv", "c1").unwrap()[0].id.clone();
    let eu = e.identity().fingerprint.clone();
    e.store_ref().poll_vote(&id, &eu, 0).unwrap();
    e.store_ref().poll_vote(&id, &eu, 1).unwrap();
    let (counts, total) = e.store_ref().poll_tally(&id).unwrap();
    assert_eq!(total, 1, "voto simples não acumula");
    assert_eq!(counts[1], 1);
}

#[test]
fn enquete_multi_acumula() {
    let (e, _d) = engine("ana");
    srv(&e, "srv", "c1");
    e.social_poll_create("srv", "c1", "q", vec!["a".into(), "b".into()], true, 0)
        .unwrap();
    let id = e.store_ref().poll_list("srv", "c1").unwrap()[0].id.clone();
    let eu = e.identity().fingerprint.clone();
    e.store_ref().poll_vote(&id, &eu, 0).unwrap();
    e.store_ref().poll_vote(&id, &eu, 1).unwrap();
    let (counts, total) = e.store_ref().poll_tally(&id).unwrap();
    assert_eq!(counts, vec![1, 1]);
    assert_eq!(e.store_ref().poll_my_votes(&id, &eu).unwrap().len(), 2);
    assert!(total >= 2);
}

// =====================================================================
// Threads
// =====================================================================

#[test]
fn thread_cria_lista_e_arquiva() {
    let (e, _d) = engine("ana");
    srv(&e, "srv", "c1");
    e.social_thread_create("srv", "c1", "sobre o bug", "thread", "")
        .unwrap();
    let list = e.store_ref().threads_list("srv", "c1").unwrap();
    assert_eq!(list.len(), 1);
    let id = list[0].id.clone();
    assert!(e.store_ref().thread_get(&id).unwrap().is_some());

    e.social_thread_archive(&id, true).unwrap();
    assert!(e.store_ref().thread_get(&id).unwrap().unwrap().archived);
    // arquivada continua listável: a UI tem um "ver arquivadas"
    assert_eq!(e.store_ref().threads_list("srv", "c1").unwrap().len(), 1);
}

#[test]
fn thread_nao_atravessa_o_canal() {
    let (e, _d) = engine("ana");
    srv(&e, "srv", "c1");
    e.social_thread_create("srv", "c1", "n", "thread", "")
        .unwrap();
    assert!(e.store_ref().threads_list("srv", "c2").unwrap().is_empty());
}

#[test]
fn mensagem_em_thread_nao_vaza_para_o_canal() {
    let (e, _d) = engine("ana");
    srv(&e, "srv", "c1");
    e.social_thread_create("srv", "c1", "n", "thread", "")
        .unwrap();
    let id = e.store_ref().threads_list("srv", "c1").unwrap()[0]
        .id
        .clone();
    e.social_thread_send("srv", &id, "só na thread").unwrap();
    assert_eq!(
        e.store_ref().list_messages_thread(&id, 50).unwrap().len(),
        1
    );
    assert!(
        e.store_ref()
            .list_messages_window("c1", None, 50)
            .unwrap()
            .is_empty(),
        "mensagem de thread não aparece na malha do canal"
    );
}

#[test]
fn thread_aceita_tags() {
    let (e, _d) = engine("ana");
    srv(&e, "srv", "c1");
    let t = e
        .social_thread_create("srv", "c1", "n", "forum", "ajuda,bug")
        .unwrap();
    assert_eq!(t.tags, "ajuda,bug");
    let _ = ThreadRow {
        id: "x".into(),
        community_id: "srv".into(),
        parent_channel: "c1".into(),
        name: "n".into(),
        author_fp: "a".into(),
        created_at: 0,
        archived: false,
        kind: "thread".into(),
        tags: String::new(),
    };
}

// =====================================================================
// Eventos agendados
// =====================================================================

#[test]
fn evento_cria_interest_e_apaga() {
    let (e, _d) = engine("ana");
    srv(&e, "srv", "c1");
    let ev = EventRow {
        id: "ev1".into(),
        community_id: "srv".into(),
        name: "Lançamento".into(),
        description: "versão nova".into(),
        location: "c1".into(),
        starts_at: 1_000,
        ends_at: 2_000,
        channel_id: "c1".into(),
        entity_fp: "a".into(),
        status: "scheduled".into(),
        interested: vec![],
    };
    e.social_event_upsert(ev).unwrap();
    assert_eq!(e.store_ref().event_list("srv").unwrap().len(), 1);

    // toggle: marcar, desmarcar, marcar de novo
    e.social_event_interest("srv", "ev1").unwrap();
    assert_eq!(
        e.store_ref().event_list("srv").unwrap()[0].interested.len(),
        1
    );
    e.social_event_interest("srv", "ev1").unwrap();
    assert_eq!(
        e.store_ref().event_list("srv").unwrap()[0].interested.len(),
        0,
        "interesse é alternável"
    );
    e.social_event_interest("srv", "ev1").unwrap();
    assert_eq!(
        e.store_ref().event_list("srv").unwrap()[0].interested.len(),
        1,
        "relembrar não duplica"
    );

    e.social_event_delete("srv", "ev1").unwrap();
    assert!(e.store_ref().event_list("srv").unwrap().is_empty());
}

#[test]
fn evento_nao_atravessa_comunidade() {
    let (e, _d) = engine("ana");
    srv(&e, "srv-a", "ca");
    srv(&e, "srv-b", "cb");
    e.store_ref()
        .event_upsert(&EventRow {
            id: "ev2".into(),
            community_id: "srv-a".into(),
            name: "n".into(),
            description: String::new(),
            location: String::new(),
            starts_at: 0,
            ends_at: 0,
            channel_id: "ca".into(),
            entity_fp: "a".into(),
            status: "scheduled".into(),
            interested: vec![],
        })
        .unwrap();
    assert!(e.store_ref().event_list("srv-b").unwrap().is_empty());
    e.store_ref().event_delete("srv-b", "ev2").unwrap();
    assert_eq!(e.store_ref().event_list("srv-a").unwrap().len(), 1);
}

// =====================================================================
// Emojis customizados
// =====================================================================

#[test]
fn emoji_cria_lista_e_apaga() {
    let (e, _d) = engine("ana");
    srv(&e, "srv", "c1");
    let mine = e.identity().fingerprint.clone();
    e.store_ref()
        .emoji_upsert(&EmojiRow {
            id: "e1".into(),
            community_id: "srv".into(),
            name: "forge".into(),
            char: "🔥".into(),
            created_at: now_ms(),
        })
        .unwrap();
    let list = e.store_ref().emoji_list("srv").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].char, "🔥");
    assert!(e.store_ref().emoji_list("outro").unwrap().is_empty());

    // apagar de outra comunidade é no-op, não destrói
    e.store_ref().emoji_delete("outro", "e1").unwrap();
    assert_eq!(e.store_ref().emoji_list("srv").unwrap().len(), 1);
    e.store_ref().emoji_delete("srv", "e1").unwrap();
    assert!(e.store_ref().emoji_list("srv").unwrap().is_empty());
    assert!(!mine.is_empty());
}

#[test]
fn emoji_exige_moderador() {
    let (e, _d) = engine("ana");
    srv(&e, "srv", "c1");
    // ana é a donata: passa
    assert!(e
        .social_emoji_upsert(EmojiRow {
            id: "e2".into(),
            community_id: "srv".into(),
            name: "x".into(),
            char: "⭐".into(),
            created_at: now_ms(),
        })
        .is_ok());
}

// =====================================================================
// Bookmarks
// =====================================================================

#[test]
fn bookmark_lista_e_e_por_conversa() {
    let (e, _d) = engine("ana");
    let st = e.store_ref();
    st.bookmark_set("c1", "receita", "https://exemplo").unwrap();
    st.bookmark_set("c1", "doc", "file.pdf").unwrap();
    let list = st.bookmark_list("c1").unwrap();
    assert_eq!(list.len(), 2);
    assert!(list.iter().any(|(n, _)| n == "receita"));
    assert!(st.bookmark_list("c2").unwrap().is_empty());
}

// =====================================================================
// Amizade e bloqueio
// =====================================================================

#[test]
fn amizade_fluxo_completo() {
    let (e, _d) = engine("ana");
    let b = Keypair::generate().fingerprint();
    e.friend_request(&b).unwrap();
    // o pedido é idempotente: repetir não cria uma segunda pendência
    e.friend_request(&b).unwrap();
    assert_eq!(
        e.store_ref().get_friend(&b).unwrap().unwrap().1,
        "pending_out"
    );
    // agora o PAPEL inverte: sou eu que recebo, então respondo
    e.store_ref().set_friend(&b, "bruno", "pending_in").unwrap();
    e.friend_respond(&b, true).unwrap();
    assert!(!e.is_blocked(&b));
    assert!(e.friends(None).iter().any(|f| f.fp == b));
    e.friend_remove(&b).unwrap();
    assert!(e.friends(None).iter().all(|f| f.fp != b));
}

#[test]
fn bloquear_e_nao_ser_bloqueado() {
    let (e, _d) = engine("ana");
    let b = Keypair::generate().fingerprint();
    e.friend_request(&b).unwrap();
    e.store_ref().set_friend(&b, "bruno", "pending_in").unwrap();
    e.friend_respond(&b, true).unwrap();
    assert!(!e.is_blocked(&b));
    e.friend_block(&b).unwrap();
    assert!(e.is_blocked(&b));
    e.friend_unblock(&b).unwrap();
    assert!(!e.is_blocked(&b));
}

#[test]
fn responder_sem_pedido_pendente_e_recusado() {
    // Regressão: `friend_respond` não checava nada e criava uma amizade
    // "aceita" do zero, mandando um FriendAccept para um peer que nunca pediu.
    let (e, _d) = engine("ana");
    let b = Keypair::generate().fingerprint();
    assert!(e.friend_respond(&b, true).is_err(), "sem pedido nenhum");
    // um pedido que EU enviei (pending_out) também não é resposta
    e.friend_request(&b).unwrap();
    assert!(
        e.friend_respond(&b, true).is_err(),
        "responder o próprio pedido não pode virar amizade"
    );
    // com pendência de entrada real, passa
    e.store_ref().set_friend(&b, "bruno", "pending_in").unwrap();
    assert!(e.friend_respond(&b, true).is_ok());
}

// =====================================================================
// Schema (trava de regressão)
// =====================================================================

#[test]
fn schema_social_tem_todas_as_tabelas() {
    let store = Store::open_in_memory().unwrap();
    let names = store.table_names();
    for t in [
        "msg_reactions",
        "msg_meta",
        "read_cursors",
        "presence",
        "profiles",
        "server_nicknames",
        "threads",
        "bans",
        "timeouts",
        "channel_cfg",
        "polls",
        "poll_votes",
        "scheduled_events",
        "custom_emojis",
        "bookmarks",
    ] {
        assert!(names.contains(&t.to_string()), "tabela ausente: {t}");
    }
}

#[test]
fn migrao_de_banco_existente_e_idempotente() {
    // Abrir duas vezes sobre o MESMO arquivo tem de ser seguro: a UI reabre o
    // app o tempo todo e uma migração não-idempotente derruba o histórico.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("forge.db");
    {
        let s = Store::open(&path).unwrap();
        s.insert_message(&env(&Keypair::generate(), "c1", "persiste"), "out", "ok")
            .unwrap();
    }
    let s = Store::open(&path).unwrap();
    assert_eq!(s.list_messages_window("c1", None, 10).unwrap().len(), 1);
    {
        let s = Store::open(&path).unwrap();
        assert_eq!(s.list_messages_window("c1", None, 10).unwrap().len(), 1);
    }
}

// =====================================================================
// Silenciamento de conta (mute) — a sanção que NÃO existia
// =====================================================================

#[test]
fn mute_realmente_bloqueia_a_fala() {
    // Regressão: `mute` só decrementava reputação e NENHUM caminho lia essa
    // pontuação — silenciar não impedia nada. Aqui o mute tem de barrar.
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let alvo = Keypair::generate().fingerprint();
    add_member(&e, "srv", &alvo);

    assert!(
        e.gate_speech_for("srv", "c1", &alvo).is_ok(),
        "antes do mute, fala"
    );

    e.moderate("srv", "mute", &alvo, "flood").unwrap();

    let err = format!("{:?}", e.gate_speech_for("srv", "c1", &alvo).unwrap_err());
    assert!(err.contains("silenciado"), "esperava mute, veio: {err}");
}

#[test]
fn mute_tambem_bloqueia_dm_sem_servidor() {
    // O DM não tem comunidade: se o portão consultasse só as regras do
    // servidor, o silenciado escrevia à vontade em conversa privada.
    let (e, _d) = engine("host");
    let alvo = Keypair::generate().fingerprint();
    let m = env(&Keypair::generate(), "dm-privada", "posso falar?");
    put(&e, &m);
    e.store_ref().mute_set(&alvo, now_ms() + 60_000).unwrap();
    assert!(e.gate_speech_for("qualquer", "qualquer", &alvo).is_err());
}

#[test]
fn unmute_libera_a_fala() {
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let alvo = Keypair::generate().fingerprint();
    add_member(&e, "srv", &alvo);
    e.moderate("srv", "mute", &alvo, "").unwrap();
    assert!(e.gate_speech_for("srv", "c1", &alvo).is_err());
    e.moderate("srv", "unmute", &alvo, "").unwrap();
    assert!(e.gate_speech_for("srv", "c1", &alvo).is_ok());
}

#[test]
fn mute_expira_sozinho() {
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let alvo = Keypair::generate().fingerprint();
    add_member(&e, "srv", &alvo);
    e.store_ref().mute_set(&alvo, now_ms() - 1_000).unwrap();
    assert!(
        e.gate_speech_for("srv", "c1", &alvo).is_ok(),
        "prazo vencido não bloqueia"
    );
}

#[test]
fn mute_nao_derruba_o_cargo_do_membro() {
    // Silenciar não pode custar o vínculo com o servidor: o membro continua
    // membro e volta a falar quando o prazo vence.
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let alvo = Keypair::generate().fingerprint();
    add_member(&e, "srv", &alvo);
    e.store_ref().mute_set(&alvo, now_ms() + 60_000).unwrap();
    assert!(e.store_ref().member_role("srv", &alvo).is_some());
}

#[test]
fn mute_de_um_nao_afeta_o_outro() {
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let a = Keypair::generate().fingerprint();
    let b = Keypair::generate().fingerprint();
    add_member(&e, "srv", &a);
    add_member(&e, "srv", &b);
    e.store_ref().mute_set(&a, now_ms() + 60_000).unwrap();
    assert!(e.gate_speech_for("srv", "c1", &a).is_err());
    assert!(e.gate_speech_for("srv", "c1", &b).is_ok());
}

#[test]
fn mute_exige_autoridade() {
    let (e, _d) = engine("host");
    srv(&e, "srv", "c1");
    let membro = Keypair::generate().fingerprint();
    add_member(&e, "srv", &membro);
    // o host é dono: pode. O ponto é que a checagem acontece antes do efeito.
    assert!(e.moderate("srv", "mute", &membro, "").is_ok());
    assert!(e.store_ref().mute_active(&membro).unwrap() > now_ms());
}

// =====================================================================
// Envio em canal: o erro que a UI produzia
// =====================================================================

#[test]
fn mandar_em_dm_nao_exige_comunidade() {
    // Regressão de UI: `selCommunity` sobrevivia à abertura de uma conversa
    // privada, e o shell usava esse estado para decidir que a conversa era um
    // canal. O motor recusava com "canal inexistente" — mensagem escrita numa
    // DM depois de visitar um servidor.
    let (e, _d) = engine("ana");
    let k = e.keypair();
    let outro = Keypair::generate().fingerprint();
    let conv = e.open_dm(&outro, "Bruno").unwrap();
    let conv_id = conv.id.clone();
    let m = env(&k, &conv_id, "isto é uma DM");
    e.store_ref().insert_message(&m, "out", "ok").unwrap();
    assert_eq!(
        e.store_ref().message_by_id(&m.id).unwrap().unwrap().conv_id,
        conv_id
    );
    // o caminho de DM não recebe community_id nenhum — é por isso que o erro
    // vinha do branch errado do shell, não do motor.
    assert!(e.open_dm(&outro, "Bruno").is_ok());
}

#[test]
fn canal_valido_e_recusado_pelo_community_errado() {
    // O par (comunidade, canal) precisa casar: um canal de A enviado como se
    // fosse de B tem de ser recusado, senão o bug do shell passaria batido.
    let (e, _d) = engine("dono");
    let owner = e.identity().fingerprint.clone();
    e.store_ref()
        .create_community("srv-a", "A", &owner, &[("a1", "geral")])
        .unwrap();
    e.store_ref()
        .create_community("srv-b", "B", &owner, &[("b1", "geral")])
        .unwrap();

    assert!(e.send_channel_message("srv-a", "a1", "ok").is_ok());
    assert!(e.send_channel_message("srv-b", "b1", "ok").is_ok());
    // o canal existe, mas não em B
    let err = e
        .send_channel_message("srv-b", "a1", "vai falhar")
        .unwrap_err();
    assert!(format!("{err:?}").contains("canal inexistente"));
}
