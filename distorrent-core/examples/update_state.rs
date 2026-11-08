// Dump completo do estado do auto-update (inclui update.skip).
// Uso: cargo run --example update_state -- <distorrent.db>
use rusqlite::Connection;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("uso: update_state <distorrent.db>");
    let conn = match Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("nao consegui abrir {path}: {e}");
            std::process::exit(1);
        }
    };
    let ler = |k: &str| -> Option<String> {
        conn.query_row("select value from kv where key=?1", [k], |r| r.get(0))
            .ok()
    };
    for k in [
        "update.skip",
        "update.failed",
        "update.applied",
        "update.auto",
        "update.last_check_ms",
        "update.backoff_ms",
        "release.update_pending",
        "release.epoch_floor",
    ] {
        let v = ler(k);
        let v = match v {
            Some(mut s) => {
                if s.len() > 220 {
                    s.truncate(220);
                    s.push_str("...");
                }
                s
            }
            None => "(ausente)".into(),
        };
        println!("{k:<26} => {v}");
    }

    if let Some(raw) = ler("update.releases_cache") {
        if let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) {
            let tags: Vec<&str> = list
                .iter()
                .filter_map(|r| r.get("tag_name").and_then(|x| x.as_str()))
                .collect();
            println!("\ncache tem {} releases: {}", tags.len(), tags.join(", "));
        }
    }
}
