use distorrent_core::storage::Store;
use rusqlite::Connection;

fn message_columns(conn: &Connection) -> Vec<String> {
    let mut st = conn
        .prepare("SELECT name FROM pragma_table_info('messages')")
        .expect("pragma_table_info");
    let rows = st
        .query_map([], |r| r.get::<_, String>(0))
        .expect("query pragma");
    rows.map(|r| r.expect("row")).collect()
}

fn build_v6_store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("distorrent.db");
    let store = Store::open(&db).unwrap();
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "INSERT INTO kv(key,value) VALUES('schema_version','6')
             ON CONFLICT(key) DO UPDATE SET value='6'",
            [],
        )
        .unwrap();
        if column_exists(&conn, "messages", "thread_id") {}
    }
    (dir, store)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    let mut st = conn
        .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
        .unwrap();
    let rows: Vec<String> = st
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    rows.iter().any(|c| c == column)
}

#[test]
fn banco_v6_sem_thread_id_e_consertado_na_abertura() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("distorrent.db");

    {
        let store = Store::open(&db).unwrap();
        store.kv_set("probe", "1").ok();
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE messages_old (
                 id TEXT PRIMARY KEY,
                 conv_id TEXT NOT NULL,
                 author_fp TEXT NOT NULL,
                 body TEXT NOT NULL,
                 ts INTEGER NOT NULL,
                 sig TEXT NOT NULL,
                 direction TEXT NOT NULL,
                 status TEXT NOT NULL,
                 bot_id TEXT NOT NULL DEFAULT ''
             );
             INSERT INTO messages_old
                 SELECT id,conv_id,author_fp,body,ts,sig,direction,status,bot_id FROM messages;
             DROP TABLE messages;
             ALTER TABLE messages_old RENAME TO messages;
             CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, ts);
             INSERT INTO kv(key,value) VALUES('schema_version','6')
               ON CONFLICT(key) DO UPDATE SET value='6';",
        )
        .unwrap();
        assert!(!column_exists(&conn, "messages", "thread_id"));
    }

    let store = Store::open(&db).unwrap();
    let conn = Connection::open(&db).unwrap();
    assert!(
        column_exists(&conn, "messages", "thread_id"),
        "v6 -> v7 não adicionou messages.thread_id"
    );
    assert!(column_exists(&conn, "messages", "bot_id"));
    let versao: u32 = conn
        .query_row("SELECT value FROM kv WHERE key='schema_version'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        versao >= 12,
        "schema atual é 12+ (lápide local e outbox.kind)"
    );

    let kp = distorrent_core::identity::Keypair::generate();
    let me = kp.fingerprint();
    let conv = store
        .ensure_dm_conversation(&me, "c00000000000", "peer")
        .unwrap();
    let env = distorrent_core::protocol::MessageEnvelope::new(&kp, &conv.id, "historico antigo");
    store.insert_message(&env, "in", "delivered").unwrap();

    let got = store
        .message_by_id(&env.id)
        .expect("message_by_id explodiu — o bug de upgrade")
        .expect("mensagem sumiu");
    assert_eq!(got.id, env.id);
    assert_eq!(got.body, "historico antigo");
    assert_eq!(got.thread_id, "");
}

#[test]
fn reabrir_schema_atual_e_idempotente() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("distorrent.db");
    {
        let _s = Store::open(&db).unwrap();
    }
    let conn = Connection::open(&db).unwrap();
    let before = message_columns(&conn).len();
    drop(conn);

    for _ in 0..3 {
        let _s = Store::open(&db).unwrap();
    }
    let conn = Connection::open(&db).unwrap();
    assert_eq!(
        message_columns(&conn).len(),
        before,
        "reabrir mudou o número de colunas de messages"
    );
    assert!(column_exists(&conn, "messages", "thread_id"));
}

#[test]
fn banco_novo_nasce_com_thread_id() {
    let store = Store::open_in_memory().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    drop(conn);
    let kp = distorrent_core::identity::Keypair::generate();
    let me = kp.fingerprint();
    let conv = store
        .ensure_dm_conversation(&me, "c00000000000", "peer")
        .unwrap();
    let env = distorrent_core::protocol::MessageEnvelope::new(&kp, &conv.id, "oi");
    store.insert_message(&env, "in", "delivered").unwrap();
    let got = store.message_by_id(&env.id).unwrap().unwrap();
    assert_eq!(got.thread_id, "");
}

#[test]
fn reabrir_preserva_bot_id_e_thread_id_do_historico() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("distorrent.db");
    let (msg_id, bot_id, thread_id) = {
        let store = Store::open(&db).unwrap();
        let kp = distorrent_core::identity::Keypair::generate();
        let me = kp.fingerprint();
        let conv = store
            .ensure_dm_conversation(&me, "c00000000000", "peer")
            .unwrap();
        let env = distorrent_core::protocol::MessageEnvelope::new(&kp, &conv.id, "oi");
        store
            .insert_message_in_thread(&env, "t-1", "in", "ok")
            .unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "UPDATE messages SET bot_id='bot-9' WHERE id=?1",
            rusqlite::params![env.id],
        )
        .unwrap();
        (env.id.clone(), "bot-9".to_string(), "t-1".to_string())
    };

    for _ in 0..3 {
        let _s = Store::open(&db).unwrap();
    }

    let conn = Connection::open(&db).unwrap();
    let (bot, thread): (String, String) = conn
        .query_row(
            "SELECT bot_id, thread_id FROM messages WHERE id=?1",
            rusqlite::params![msg_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("mensagem sumiu ao reabrir");
    assert_eq!(
        bot, bot_id,
        "bot_id era zerado a cada abertura (\"10\" < \"2\" em string)"
    );
    assert_eq!(thread, thread_id, "thread_id idem");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1,
        "reabrir não pode duplicar nem perder linha"
    );
}

#[test]
fn mensagem_apagada_so_para_mim_nao_volta_na_sincronizacao() {
    let store = Store::open_in_memory().unwrap();
    let kp = distorrent_core::identity::Keypair::generate();
    let me = kp.fingerprint();
    let conv = store
        .ensure_dm_conversation(&me, "c00000000000", "peer")
        .unwrap();
    let env = distorrent_core::protocol::MessageEnvelope::new(&kp, &conv.id, "apagar isto");
    store.insert_message(&env, "in", "ok").unwrap();

    assert_eq!(store.hide_messages_local(&[env.id.clone()]).unwrap(), 1);
    assert!(
        store.message_by_id(&env.id).unwrap().is_none(),
        "sumiu daqui"
    );
    assert_eq!(store.count_hidden().unwrap(), 1, "a lápide ficou");

    store.insert_message(&env, "in", "ok").unwrap();
    assert!(
        store.message_by_id(&env.id).unwrap().is_none(),
        "o outro lado reenvia o mesmo id: NÃO pode reaparecer"
    );
}

#[test]
fn limpeza_automatica_respeita_prazo_e_escopo() {
    let store = Store::open_in_memory().unwrap();
    let kp = distorrent_core::identity::Keypair::generate();
    let me = kp.fingerprint();
    let dm = store
        .ensure_dm_conversation(&me, "c00000000000", "peer")
        .unwrap();
    let grupo = store
        .create_group_dm(&me, &["c00000000000".to_string()], "grupo")
        .unwrap();

    let velho = |body: &str| {
        let mut env = distorrent_core::protocol::MessageEnvelope::new(&kp, "x", body);
        env.ts = 1_000;
        env
    };
    let mut m_dm = velho("dm antiga");
    m_dm.conv_id = dm.id.clone();
    let mut m_gr = velho("grupo antigo");
    m_gr.conv_id = grupo.id.clone();
    let mut m_novo = velho("recente");
    m_novo.conv_id = dm.id.clone();
    m_novo.ts = distorrent_core::identity::now_ms() + 3_600_000;

    store.insert_message(&m_dm, "in", "ok").unwrap();
    store.insert_message(&m_gr, "in", "ok").unwrap();
    store.insert_message(&m_novo, "in", "ok").unwrap();

    assert_eq!(
        store
            .expired_message_ids(0, false, false, false, 100)
            .unwrap()
            .len(),
        0
    );

    let ids = store
        .expired_message_ids(distorrent_core::identity::now_ms(), true, true, true, 100)
        .unwrap();
    assert_eq!(ids.len(), 2, "dm + grupo, ambos antigos");
    assert!(!ids.contains(&m_novo.id), "mensagem dentro do prazo fica");

    let so_dms = store
        .expired_message_ids(distorrent_core::identity::now_ms(), false, false, true, 100)
        .unwrap();
    assert_eq!(
        so_dms,
        vec![m_dm.id.clone()],
        "escopo é independente: só DM quando só DM está ligada"
    );

    let so_grupos = store
        .expired_message_ids(distorrent_core::identity::now_ms(), false, true, false, 100)
        .unwrap();
    assert_eq!(
        so_grupos,
        vec![m_gr.id.clone()],
        "escopo é independente por tipo"
    );

    assert_eq!(store.hide_messages_local(&ids).unwrap(), 2);
    assert_eq!(store.count_messages().unwrap(), 1, "só a recente sobrou");
}

#[test]
fn _silence_unused_helper() {
    let _ = build_v6_store;
}
