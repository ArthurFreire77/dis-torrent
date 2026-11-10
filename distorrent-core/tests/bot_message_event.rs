// Regressão: o dono do servidor digitando no canal precisa emitir MessageNew.
// Sem isso o runtime de bots do próprio dono nunca via o comando e `!ping`
// ficava sem resposta (o sintoma "o bot não faz nada no meu server").

use std::sync::Arc;

use distorrent_core::net::engine::{EngineEvent, NetworkEngine};
use distorrent_core::storage::Store;
use tempfile::TempDir;

fn engine_for(nick: &str) -> (Arc<NetworkEngine>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = distorrent_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    (engine, dir)
}

#[test]
fn mensagem_enviada_pelo_dono_emite_message_new() {
    let (e, _d) = engine_for("Dono");
    let cid = e.create_community("Resenha", &[]).unwrap();
    // A comunidade já nasce com #geral; criar outro de mesmo nome seria erro.
    let ch = e
        .store
        .list_channels(&cid)
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let ch_id = ch.0.clone();

    // Assina ANTES de mandar: o evento sai junto com a gravação.
    let mut rx = e.subscribe();
    e.send_channel_message(&cid, &ch_id, "!ping").unwrap();

    let ev = rx.try_recv().expect("o envio precisa emitir EngineEvent");
    match ev {
        EngineEvent::MessageNew(m) => {
            assert_eq!(m.body, "!ping");
            assert_eq!(m.direction, "out");
            assert_eq!(m.bot_id, "");
        }
        other => panic!("esperava MessageNew, veio {other:?}"),
    }
}
