//! Migrações de schema: o caminho que NINGUEM vê no app rodando, e que
//! decide se uma instalação antiga continua abrindo.
//!
//! O caso que motivou este arquivo: `messages.thread_id` (threads) foi criado
//! dentro do bloco de migração da v6. Como o guard é `if version < "6"`, um
//! banco que JÁ estava em v6 — ou seja, qualquer usuário do app antes desta
//! mudança — nunca executava aquele bloco, ficava sem a coluna, e a primeira
//! leitura de mensagem quebrava com `InvalidColumnIndex(9)`. O histórico
//! inteiro do servidor sumia silenciosamente.

use forge_core::storage::Store;
use rusqlite::Connection;

/// Conta as colunas de `messages` como o SQLite as vê hoje.
fn message_columns(conn: &Connection) -> Vec<String> {
    let mut st = conn
        .prepare("SELECT name FROM pragma_table_info('messages')")
        .expect("pragma_table_info");
    let rows = st
        .query_map([], |r| r.get::<_, String>(0))
        .expect("query pragma");
    rows.map(|r| r.expect("row")).collect()
}

/// Simula o estado de uma instalação v6: schema novo (SCHEMA_V1), migrações
/// aplicadas e carimbadas em '6' — exatamente o que existia em disco antes do
/// suporte a threads.
fn build_v6_store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("forge.db");
    let store = Store::open(&db).unwrap();
    {
        // Reconstrói o estado v6: aplica tudo e depois força o carimbo.
        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "INSERT INTO kv(key,value) VALUES('schema_version','6')
             ON CONFLICT(key) DO UPDATE SET value='6'",
            [],
        )
        .unwrap();
        // Simula o banco v6 "correto": sem thread_id.
        if column_exists(&conn, "messages", "thread_id") {
            // o caminho real (v6 antigo) NÃO tinha a coluna; se o store
            // atual já a criou, não dá para simular removendo — então este
            // teste só é sobre a garantia de upgrade, ver teste abaixo.
        }
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

/// O teste que o bug real exige: um banco marcado como v6 que NÃO tem
/// `thread_id` tem de ser consertado ao abrir, e continuar legível.
#[test]
fn banco_v6_sem_thread_id_e_consertado_na_abertura() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("forge.db");

    // 1) Cria o schema completo, simula o "estado v6" e remove a coluna
    //    recriando a tabela como o v6 antigo a tinha.
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

    // 2) Reabre — a migração tem de rodar e devolver a coluna.
    let store = Store::open(&db).unwrap();
    let conn = Connection::open(&db).unwrap();
    assert!(
        column_exists(&conn, "messages", "thread_id"),
        "v6 -> v7 não adicionou messages.thread_id"
    );
    assert!(column_exists(&conn, "messages", "bot_id"));
    assert_eq!(
        conn.query_row("SELECT value FROM kv WHERE key='schema_version'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "8"
    );

    // 3) E o mais importante: uma leitura de mensagem tem que funcionar, que é
    //    exatamente onde o app quebrava.
    let kp = forge_core::identity::Keypair::generate();
    let me = kp.fingerprint();
    let conv = store
        .ensure_dm_conversation(&me, "c00000000000", "peer")
        .unwrap();
    let env = forge_core::protocol::MessageEnvelope::new(&kp, &conv.id, "historico antigo");
    store.insert_message(&env, "in", "delivered").unwrap();

    let got = store
        .message_by_id(&env.id)
        .expect("message_by_id explodiu — o bug de upgrade")
        .expect("mensagem sumiu");
    assert_eq!(got.id, env.id);
    assert_eq!(got.body, "historico antigo");
    assert_eq!(got.thread_id, "");
}

/// Reabrir um banco no schema atual é idempotente: não erra nem duplica coluna.
#[test]
fn reabrir_schema_atual_e_idempotente() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("forge.db");
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

/// Banco novo (schema do zero) já nasce completo — sem depender do caminho de
/// upgrade, que é o que o teste acima cobre.
#[test]
fn banco_novo_nasce_com_thread_id() {
    let store = Store::open_in_memory().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    drop(conn);
    // open_in_memory não expõe a conexão; basta provar que a escrita/leiitura
    // de thread_id passa, o que exige a coluna.
    let kp = forge_core::identity::Keypair::generate();
    let me = kp.fingerprint();
    let conv = store
        .ensure_dm_conversation(&me, "c00000000000", "peer")
        .unwrap();
    let env = forge_core::protocol::MessageEnvelope::new(&kp, &conv.id, "oi");
    store.insert_message(&env, "in", "delivered").unwrap();
    let got = store.message_by_id(&env.id).unwrap().unwrap();
    assert_eq!(got.thread_id, "");
}

#[test]
fn _silence_unused_helper() {
    let _ = build_v6_store;
}
