// Prova que subir a security_epoch da ponte faz o DESEMPATE QUEBRADO do 1.1.63
// escolher o manifesto certo.
//
// O 1.1.63 faz: if epoch_novo >= epoch_atual { latest = novo }, iterando os
// manifestos em ordem de hash. Com epoch EMPATADA, o vencedor é o último da
// ordem (pode ser a 1.1.64). Com epoch ESTRITAMENTE maior, o 1.1.65 vence
// sempre, independente da ordem.
//
// Uso: cargo run --example epoch_tiebreak -- <dir> <manifest:epoch>...
use distorrent_core::release::manifest::SignedManifest;

fn main() {
    let dir = std::env::args().nth(1).expect("dir");
    let pares: Vec<(String, u64)> = std::env::args()
        .skip(2)
        .map(|p| {
            let (f, e) = p.split_once(':').expect("arquivo:epoch");
            (format!("{dir}/{f}"), e.parse().expect("epoch"))
        })
        .collect();

    // Monta (hash, versao, epoch) como o 1.1.63 veria.
    let mut itens: Vec<(String, String, u64)> = Vec::new();
    for (arquivo, epoch_declarada) in &pares {
        let Ok(bytes) = std::fs::read(arquivo) else {
            continue;
        };
        let Ok(signed) = SignedManifest::from_wire(&bytes) else {
            continue;
        };
        let hash = signed.body.hash_hex().unwrap_or_default();
        itens.push((hash, signed.body.version.clone(), *epoch_declarada));
    }
    // O kv é um BTreeMap: ordem lexicográfica de hash.
    itens.sort_by(|a, b| a.0.cmp(&b.0));

    println!("ordem em que o 1.1.63 itera (hash):");
    for (h, v, e) in &itens {
        println!("  {}  {:<20} epoch={}", &h[..12], v, e);
    }

    // Replica EXATAMENTE o desempate bugado do 1.1.63.
    let mut latest: Option<(String, u64)> = None;
    for (_, v, e) in &itens {
        let passa = latest.as_ref().map_or(true, |(_, atual)| e >= atual);
        if passa {
            latest = Some((v.clone(), *e));
        }
    }
    let escolhido = latest.map(|(v, _)| v).unwrap_or_default();
    println!("\n1.1.63 escolheria: {escolhido}");
    if escolhido.starts_with("1.1.65") {
        println!("\nRESULTADO: OK — o desempate bugado cai na ponte mesmo assim.");
    } else {
        println!("\nRESULTADO: RUIM — escolheu a versao errada; o download falharia.");
    }
}
