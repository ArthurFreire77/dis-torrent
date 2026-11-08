// Liga/desliga o auto-update direto no banco (o app precisa estar FECHADO).
// Uso: cargo run --example set_update_auto -- <distorrent.db> on|off
use rusqlite::Connection;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("uso: set_update_auto <db> on|off");
    let valor = args.next().unwrap_or_else(|| "on".into());
    let v = if valor == "off" { "0" } else { "1" };
    let conn = match Connection::open(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("nao consegui abrir {path}: {e}");
            std::process::exit(1);
        }
    };
    conn.execute(
        "insert into kv(key,value) values('update.auto',?1)
         on conflict(key) do update set value=excluded.value",
        [v],
    )
    .expect("gravar update.auto");
    let lido: Option<String> = conn
        .query_row("select value from kv where key='update.auto'", [], |r| {
            r.get(0)
        })
        .ok();
    println!("update.auto => {lido:?} ({}),", v);
}
