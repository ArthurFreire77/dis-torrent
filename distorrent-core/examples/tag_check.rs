// Prova o bug do auto-update: compara a versao do manifesto com a tag do GitHub
// do jeito que o cliente 1.1.63 fazia (igualdade exata) e do jeito correto
// (comparacao de versao, ignorando o sufixo -pre-alpha).
// Uso: cargo run --example tag_check -- <manifest.bin> <tag do GitHub>
use distorrent_core::release::manifest::SignedManifest;

fn main() {
    let mut args = std::env::args().skip(1);
    let manifest_path = args.next().expect("uso: tag_check <manifest.bin> <tag>");
    let tag = args.next().expect("uso: tag_check <manifest.bin> <tag>");
    let bytes = std::fs::read(&manifest_path).expect("ler manifesto");
    let signed = SignedManifest::from_wire(&bytes).expect("manifesto invalido");
    let vm = signed.body.version.clone();
    let tag_limpa = tag.trim_start_matches('v');
    println!("manifesto declara : {vm}");
    println!("tag do GitHub     : {tag} -> {tag_limpa}");
    let igualdade = vm == tag_limpa;
    println!(
        "\ncliente 1.1.63 (igualdade exata): {}",
        if igualdade { "PASSA" } else { "RECUSA" }
    );
    // A comparacao de versao que o update usa para decidir se ha versao nova.
    let mesma = normalize(&vm) == normalize(tag_limpa);
    println!(
        "comparacao normalizada          : {}",
        if mesma { "PASSA" } else { "RECUSA" }
    );
    if !igualdade {
        println!("\n>>> BUG CONFIRMADO: toda release e recusada por 'divergencia de versao'.");
    }
}

fn normalize(v: &str) -> String {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split('-')
        .next()
        .unwrap_or("")
        .to_string()
}
