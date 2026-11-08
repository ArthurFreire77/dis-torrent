// Destrava o auto-update de um cliente ANTIGO (1.1.63 e anteriores).
//
// Por que isso é necessário: o 1.1.63 guarda a lista de releases por 6 h e,
// dentro dessa janela, responde só do cache. O cache dele foi gravado antes da
// release-ponte existir, então ele nem tenta o GitHub. Apagando a lista, o
// cliente cai no caminho de consulta real na próxima abertura — e aí aceita a
// release cuja TAG casa com a versão.
//
// Uso: cargo run --example clear_update_cache -- <distorrent.db> [--dry-run]
use rusqlite::Connection;

const CACHE: &str = "update.releases_cache";
const LAST: &str = "update.last_check_ms";
const FAILED: &str = "update.failed";

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("uso: clear_update_cache <distorrent.db>");
    let dry = args.any(|a| a == "--dry-run");
    let conn = match Connection::open(&path) {
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

    println!("antes:");
    println!("  {CACHE}  => {} bytes", ler(CACHE).map(|v| v.len()).unwrap_or(0));
    println!("  {LAST}   => {:?}", ler(LAST));
    println!("  {FAILED} => {:?}", ler(FAILED));

    if dry {
        println!("\n(dry-run: nada alterado)");
        return;
    }

    // Apaga a LISTA (é o que prende o cliente na janela de 6 h). Mantém
    // `update.last_check_ms` para o backoff continuar coerente.
    let n1 = conn.execute("delete from kv where key=?1", [CACHE]).unwrap_or(0);
    // Marca de falha de uma versão antiga (1.1.62) não deve assombrar.
    let n2 = conn.execute("delete from kv where key=?1", [FAILED]).unwrap_or(0);
    println!("\napagadas: {n1} lista(s) de releases, {n2} marca(s) de falha");
    println!("PROXIMO PASSO: feche e reabra o DisTorrent. Na abertura ele consulta");
    println!("o GitHub de verdade e baixa a versao nova sozinho.");
}
