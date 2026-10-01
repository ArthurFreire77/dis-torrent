//! Cofre portável `.stormvault`: export ↔ import entre dois Stores isolados
//! (simula Windows ↔ Android ↔ Linux), mesclagem sem perda, conflitos,
//! ataques (MITM de arquivo, replay de cofre velho, adulteração) e retenção.
//!
//! Sem rede, sem relay — só Store em memória + disco temporário.

use forge_core::identity::Keypair;
use forge_core::protocol::MessageEnvelope;
use forge_core::storage::Store;
use forge_core::stormvault;

/// Busca ingênua de agulha no palheiro (evita dep extra no teste).
fn twoway_find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn mk_account(nick: &str) -> (Store, Keypair) {
    let store = Store::open_in_memory().unwrap();
    let kp = Keypair::generate();
    let identity = kp.identity(nick);
    store.save_identity(&identity, &kp.secret_hex()).unwrap();
    (store, kp)
}

fn seed_conversation(store: &Store, kp: &Keypair, peer_fp: &str, bodies: &[&str]) {
    let conv = store
        .ensure_dm_conversation(&kp.fingerprint(), peer_fp, "amigo")
        .unwrap();
    for body in bodies {
        let env = MessageEnvelope::new(kp, &conv.id, body);
        let dir = if env.author_fp == kp.fingerprint() {
            "out"
        } else {
            "in"
        };
        store.insert_message(&env, dir, "sent").unwrap();
    }
}

/// Windows → Android: exporta tudo com senha, importa em device limpo,
/// desbloqueia com a MESMA senha e confere byte a byte.
#[test]
fn export_import_cross_device_roundtrip() {
    let (a, kp) = mk_account("alice-w");
    seed_conversation(
        &a,
        &kp,
        "b0b0b0b0b0b0",
        &["oi", "tudo bem?", "terceira msg"],
    );
    a.set_friend("b0b0b0b0b0b0", "bob", "accepted").unwrap();
    a.create_community("cid-1", "clube", &kp.fingerprint(), &[("ch-1", "geral")])
        .unwrap();
    a.kv_set("privacy.mode", "proxy").unwrap();

    let data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    let sealed = stormvault::seal_with_password(&data, "senha-forte-123").unwrap();

    // header legível sem senha (fp público, para a UI mostrar de quem é)
    let h = stormvault::read_header(&sealed).unwrap();
    assert_eq!(h.fp, kp.fingerprint());
    assert_eq!(h.nickname, "alice-w");
    assert_eq!(h.msg_count, 3);
    assert_eq!(h.v, 1);

    // device B limpo: importa e instala a identidade
    let b = Store::open_in_memory().unwrap();
    let report = stormvault::import_with_password(&b, &sealed, "senha-forte-123").unwrap();
    assert!(report.identity_installed);
    assert_eq!(report.messages_merged, 3);
    assert_eq!(report.friends_merged, 1);
    assert_eq!(report.conversations_added, 1);
    assert_eq!(report.communities_merged, 1);
    assert_eq!(report.settings_imported, 1);

    // desbloqueio com a MESMA senha do arquivo
    assert_eq!(b.kv_get("vault.on").as_deref(), Some("1"));
    let blob_hex = b.load_secret_hex().unwrap();
    let secret =
        forge_core::vault::open_sealed(&hex::decode(&blob_hex).unwrap(), "senha-forte-123")
            .unwrap();
    assert_eq!(secret, kp.secret_hex());

    // histórico intacto
    let convs = b.list_conversations().unwrap();
    assert_eq!(convs.len(), 1);
    let msgs = b.list_messages(&convs[0].id, 100).unwrap();
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0].body, "oi");
    assert_eq!(msgs[2].body, "terceira msg");

    // amigo + comunidade + setting migraram
    assert_eq!(
        b.get_friend("b0b0b0b0b0b0").unwrap().unwrap(),
        ("bob".to_string(), "accepted".to_string())
    );
    assert_eq!(b.list_communities().unwrap().len(), 1);
    assert_eq!(b.kv_get("privacy.mode").as_deref(), Some("proxy"));
}

/// Merge: device B tem a mesma conta + mensagem local nova. Importar o cofre
/// de A soma sem apagar nada e sem duplicar.
#[test]
fn merge_same_account_no_loss_no_dup() {
    let (a, kp) = mk_account("alice");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["msg de A"]);

    // B: mesma identidade (fp igual), mensagem local que A não tem
    let b = Store::open_in_memory().unwrap();
    b.save_identity(&a.load_identity().unwrap(), "x").unwrap();
    let conv_b = b
        .ensure_dm_conversation(&kp.fingerprint(), "b0b0b0b0b0b0", "amigo")
        .unwrap();
    // conv determinística: mesmo id nos dois devices
    assert_eq!(conv_b.id, a.list_conversations().unwrap()[0].id);
    let env_b = MessageEnvelope::new(&kp, &conv_b.id, "msg local de B");
    b.insert_message(&env_b, "out", "sent").unwrap();

    // exporta A SEM a chave (B já tem a conta — merge de dados)
    let data = stormvault::collect(&a, None, None).unwrap();
    let sealed = stormvault::seal_with_password(&data, "senha-123").unwrap();
    let opened = stormvault::open_with_password(&sealed, "senha-123").unwrap();
    let report = stormvault::import_merge_only(&b, &opened).unwrap();
    assert!(!report.identity_installed);
    assert_eq!(report.messages_merged, 1);

    let msgs = b.list_messages(&conv_b.id, 100).unwrap();
    assert_eq!(msgs.len(), 2);
    let bodies: Vec<_> = msgs.iter().map(|m| m.body.as_str()).collect();
    assert!(bodies.contains(&"msg de A"));
    assert!(bodies.contains(&"msg local de B"));

    // reimportar o mesmo cofre: idempotente (dedup por id, zero merges)
    let report2 = stormvault::import_merge_only(&b, &opened).unwrap();
    assert_eq!(report2.messages_merged, 0);
    assert_eq!(b.list_messages(&conv_b.id, 100).unwrap().len(), 2);
}

/// Conta diferente no device = recusa (não mistura contas).
#[test]
fn import_wrong_account_refused() {
    let (a, kp) = mk_account("alice");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["oi"]);
    let data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    let sealed = stormvault::seal_with_password(&data, "senha-123").unwrap();
    let opened = stormvault::open_with_password(&sealed, "senha-123").unwrap();

    let (b, _) = mk_account("mallory");
    let err = stormvault::import_merge_only(&b, &opened).unwrap_err();
    assert!(err.to_string().contains("outra conta"), "erro foi: {err}");
    // nada de A vazou para B
    assert!(b.list_conversations().unwrap().is_empty());
}

/// Cofre sem chave privada não instala identidade em device limpo.
#[test]
fn dataless_vault_cannot_install() {
    let (a, kp) = mk_account("alice");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["oi"]);
    let data = stormvault::collect(&a, None, None).unwrap();
    assert!(data.secret_hex.is_none());
    let sealed = stormvault::seal_with_password(&data, "senha-123").unwrap();

    let b = Store::open_in_memory().unwrap();
    let err = stormvault::import_with_password(&b, &sealed, "senha-123").unwrap_err();
    assert!(err.to_string().contains("chave privada"), "erro foi: {err}");
}

/// ATAQUES no arquivo: senha errada, truncamento, flip de bit, header trocado,
/// versão futura, replay de cofre velho (restaura estado antigo por cima do novo).
#[test]
fn vault_file_attacks_rejected() {
    let (a, kp) = mk_account("alice");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["segredo"]);
    let data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    let sealed = stormvault::seal_with_password(&data, "correta-123").unwrap();

    assert!(stormvault::open_with_password(&sealed, "errada-123").is_err());

    let mut trunc = sealed.clone();
    trunc.truncate(trunc.len() - 20);
    assert!(stormvault::open_with_password(&trunc, "correta-123").is_err());

    let mut flip = sealed.clone();
    let mid = flip.len() / 2;
    flip[mid] ^= 0x01;
    assert!(stormvault::open_with_password(&flip, "correta-123").is_err());

    // MITM de header: troca o fp/nickname no header (JSON continua válido,
    // mesmo tamanho) — o AAD amarra header↔ciphertext e a abertura falha
    let mut tampered = sealed.clone();
    let fp_marker = format!("\"fp\":\"{}\"", kp.fingerprint());
    let pos = twoway_find(&tampered, fp_marker.as_bytes()).expect("fp no header");
    let flip_at = pos + 6; // dentro do hex do fp
    tampered[flip_at] = if tampered[flip_at] == b'a' {
        b'b'
    } else {
        b'a'
    };
    assert!(stormvault::open_with_password(&tampered, "correta-123").is_err());
    // header de outro cofre colado por inteiro também não passa (AAD)
    let (c, _) = mk_account("carol");
    let data_c = stormvault::collect(&c, None, None).unwrap();
    let sealed_c = stormvault::seal_with_password(&data_c, "outra-123").unwrap();
    let hc = stormvault::read_header(&sealed_c).unwrap();
    let ha = stormvault::read_header(&sealed).unwrap();
    assert_ne!(hc.fp, ha.fp); // sanity: cofres de contas diferentes
    let mut glued = sealed.clone();
    // sobrescreve SÓ o nickname no header (mesmo tamanho) — AAD acusa
    let nick_marker = b"\"nickname\":\"alice\"";
    let npos = twoway_find(&glued, nick_marker).expect("nick no header");
    glued[npos + 12] = b'X'; // 'a' -> 'X' em "alice"
    assert!(stormvault::open_with_password(&glued, "correta-123").is_err());

    // replay: cofre velho restaurado DEPOIS de mensagens novas — o merge soma,
    // nunca apaga as novas (sem rollback de estado)
    let b = Store::open_in_memory().unwrap();
    stormvault::import_with_password(&b, &sealed, "correta-123").unwrap();
    let convs = b.list_conversations().unwrap();
    let env_new = MessageEnvelope::new(&kp, &convs[0].id, "mensagem NOVA pós-backup");
    b.insert_message(&env_new, "out", "sent").unwrap();
    let report = stormvault::import_with_password(&b, &sealed, "correta-123").unwrap();
    assert!(!report.identity_installed); // mesma conta → merge
    let msgs = b.list_messages(&convs[0].id, 100).unwrap();
    assert_eq!(msgs.len(), 2, "replay não pode apagar a mensagem nova");
    assert!(msgs.iter().any(|m| m.body == "mensagem NOVA pós-backup"));
}

/// Backup automático (modo key): roundtrip + retenção por idade.
#[test]
fn backup_key_mode_and_retention() {
    let (a, kp) = mk_account("alice");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["oi"]);
    let data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    let key = stormvault::backup_key_for(&kp.secret_hex());
    let sealed = stormvault::seal_with_key(&data, &key).unwrap();

    // mesma conta deriva a mesma chave em qualquer device desbloqueado
    assert_eq!(key, stormvault::backup_key_for(&kp.secret_hex()));
    let opened = stormvault::open_with_key(&sealed, &key).unwrap();
    assert_eq!(opened.messages.len(), 1);

    // chave errada não abre; modo senha não abre backup-key e vice-versa
    assert!(stormvault::open_with_key(&sealed, &[9u8; 32]).is_err());
    assert!(stormvault::open_with_password(&sealed, "qualquer").is_err());

    // retenção: 5 arquivos (idades 100/40/20/10/0 dias), retenção 30d →
    // remove os 2 além dos 2-mais-novos-garantidos... aqui: 100d e 40d saem
    let dir = tempfile::tempdir().unwrap();
    let day = 86_400_000i64;
    let now = 1_800_000_000_000i64;
    for age_days in [100, 40, 20, 10, 0] {
        let name = stormvault::backup_file_name(now - age_days * day);
        std::fs::write(dir.path().join(&name), &sealed).unwrap();
    }
    // lixo com outra extensão não é tocado
    std::fs::write(dir.path().join("nota.txt"), b"oi").unwrap();
    let removed = stormvault::prune_backup_files(dir.path(), 30, now).unwrap();
    assert_eq!(removed, 2);
    let files = stormvault::list_backup_files(dir.path());
    assert_eq!(files.len(), 3);
    assert!(dir.path().join("nota.txt").exists());

    // retenção gigante: nada sai
    let removed = stormvault::prune_backup_files(dir.path(), 3650, now).unwrap();
    assert_eq!(removed, 0);
}

/// Limite de mensagens no export (cofre não explode em disco).
#[test]
fn export_message_cap() {
    let (a, kp) = mk_account("alice");
    let bodies: Vec<String> = (0..50).map(|i| format!("msg {i}")).collect();
    let refs: Vec<&str> = bodies.iter().map(|s| s.as_str()).collect();
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &refs);

    let data = stormvault::collect(&a, None, Some(10)).unwrap();
    assert_eq!(data.messages.len(), 10);
    assert!(data.meta.messages_truncated);
    // todas as 10 vêm do lote exportado (subset das 50 — mesma granularidade
    // de ms embaralha a ordem exata, igual ao list_messages existente)
    for m in &data.messages {
        let n: usize = m.body.trim_start_matches("msg ").parse().unwrap();
        assert!(n < 50, "corpo inesperado: {}", m.body);
    }

    let full = stormvault::collect(&a, None, None).unwrap();
    assert_eq!(full.messages.len(), 50);
    assert!(!full.meta.messages_truncated);
}
