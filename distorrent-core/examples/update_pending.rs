// Diagnostico do auto-update: mostra pending, manifest_hash e se o manifesto
// verificado correspondente ainda existe no banco. Uso:
//   cargo run --example update_pending -- <distorrent.db>
use rusqlite::Connection;

fn main() {
    let path = std::env::args().nth(1).expect("db");
    let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("abrir db");
    let ler = |k: &str| -> Option<String> {
        conn.query_row("select value from kv where key=?1", [k], |r| r.get(0))
            .ok()
    };

    println!("--- pending ---");
    match ler("release.update_pending") {
        Some(raw) => {
            println!("{raw}");
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                let hash = v
                    .get("manifest_hash")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let epoch = v
                    .get("security_epoch")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                println!("\nmanifest_hash : {hash}");
                println!("security_epoch: {epoch}");
                let chave = format!("release.manifest.{hash}");
                let existe = ler(&chave).is_some();
                println!("manifesto salvo ({chave}): {existe}");
                if !existe {
                    println!("\n>>> o pending aponta para um manifesto que NAO esta no banco:");
                    println!("    save_download exige trust.latest_verified() com este hash.");
                }
            }
        }
        None => println!("(ausente)"),
    }

    println!("\n--- manifestos no banco ---");
    let mut st = conn
        .prepare("select key from kv where key like 'release.manifest.%'")
        .expect("prepare");
    let keys: Vec<String> = st
        .query_map([], |r| r.get(0))
        .map(|rows| rows.filter_map(|x| x.ok()).collect())
        .unwrap_or_default();
    for k in &keys {
        println!("  {k}");
    }
    println!("total: {}", keys.len());
    println!("\nepoch_floor: {:?}", ler("release.epoch_floor"));
}
