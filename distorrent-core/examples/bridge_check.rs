// Reproduz a decisao do cliente ANTIGO (1.1.63) e do NOVO para uma tag:
// o antigo exige `manifesto == tag_sem_v` (igualdade exata); o novo compara
// o nucleo N.N.N. Mostra qual tag faz os DOIS aceitarem a mesma release.
// Uso: cargo run --example bridge_check -- <manifest.bin> <tag>
use distorrent_core::release::manifest::SignedManifest;

fn nucleo(v: &str) -> String {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split('-')
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("uso: bridge_check <manifest.bin> <tag>");
    let tag = args.next().expect("uso: bridge_check <manifest.bin> <tag>");
    let bytes = std::fs::read(&path).expect("ler manifesto");
    let signed = SignedManifest::from_wire(&bytes).expect("manifesto invalido");
    let vm = signed.body.version.clone();
    let limpa = tag.trim_start_matches('v');
    println!("manifesto : {vm}");
    println!("tag       : {tag}  (sem v: {limpa})");
    println!(
        "cliente ANTIGO (igualdade) : {}",
        if vm == limpa { "ACEITA" } else { "RECUSA" }
    );
    println!(
        "cliente NOVO   (nucleo)     : {}",
        if nucleo(&vm) == nucleo(&tag) {
            "ACEITA"
        } else {
            "RECUSA"
        }
    );
    if vm != limpa {
        println!("\nPara o cliente antigo aceitar, a tag precisa ser exatamente \"v{vm}\".");
    }
}
