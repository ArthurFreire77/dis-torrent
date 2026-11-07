use super::*;

fn mk(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = Keypair::generate();
    let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    (e, dir)
}

#[tokio::test]
async fn liberar_entrada_relay_remove_a_entrada() {
    let (engine, _dir) = mk("relay-lock");
    let fp = "aa11bb22cc33";

    let (_stream, meu) = relay_dial_stream(&engine, fp).expect("primeiro dial cria stream");
    {
        let mapa = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
        assert!(mapa.get(fp).is_some(), "o dial registra a ponta de entrada");
    }

    liberar_entrada_relay(&engine, fp, &meu);

    let mapa = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
    assert!(
        mapa.get(fp).is_none(),
        "depois de liberar, a trava some e o peer volta a ser discavel"
    );
}

#[tokio::test]
async fn liberar_nao_remove_entrada_de_outro_dono() {
    let (engine, _dir) = mk("relay-lock2");
    let fp = "dd44ee55ff66";

    let (_stream, _meu) = relay_dial_stream(&engine, fp).expect("cria stream");

    let (outro, _rx) = mpsc::unbounded_channel::<Vec<u8>>();
    liberar_entrada_relay(&engine, fp, &outro);

    let mapa = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
    assert!(
        mapa.get(fp).is_some(),
        "a entrada de outro dono tem de sobreviver"
    );
}
