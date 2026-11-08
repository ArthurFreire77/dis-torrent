// Simula a VARREDURA COMPLETA de um cliente ANTIGO (1.1.63) sobre as releases
// reais, na ordem em que ele examina. Prova que qualquer usuário chega na
// release-ponte, mesmo recusando as outras.
// Uso: cargo run --example old_client_scan -- <dir com os manifestos> <tag:arquivo>...
use distorrent_core::release::manifest::SignedManifest;
use distorrent_core::release::trust::{bootstrap_trust_set, verify_manifest, ReleaseStatus};

fn nucleo(v: &str) -> String {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split('-')
        .next()
        .unwrap_or("")
        .to_string()
}

/// Ordem que o cliente usa: maior versao primeiro.
fn cmp_versao(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<u64> = nucleo(a)
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    let pb: Vec<u64> = nucleo(b)
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    // Empate no nucleo: o sufixo conta; aqui basta distinguir "tem sufixo".
    let sa = a.contains('-');
    let sb = b.contains('-');
    match (sa, sb) {
        (false, true) => std::cmp::Ordering::Greater,
        (true, false) => std::cmp::Ordering::Less,
        _ => std::cmp::Ordering::Equal,
    }
}

fn main() {
    let dir = std::env::args().nth(1).expect("dir dos manifestos");
    let pares = std::env::args().skip(2).collect::<Vec<_>>();
    let atual = "1.1.63";

    let mut candidatas = Vec::new();
    for par in pares {
        let (tag, arquivo) = par.split_once(':').expect("tag:arquivo");
        if cmp_versao(tag, atual) != std::cmp::Ordering::Greater {
            continue;
        }
        candidatas.push((tag.to_string(), format!("{dir}/{arquivo}")));
    }
    candidatas.sort_by(|a, b| cmp_versao(&b.0, &a.0));

    println!("cliente 1.1.63 examina, nesta ordem:");
    for (tag, _) in &candidatas {
        println!("  {tag}");
    }
    println!();

    let trust = bootstrap_trust_set().expect("trust");
    for (tag, arquivo) in &candidatas {
        let Ok(bytes) = std::fs::read(arquivo) else {
            println!("{tag}: manifesto ausente");
            continue;
        };
        let Ok(signed) = SignedManifest::from_wire(&bytes) else {
            println!("{tag}: RECUSA (manifesto invalido)");
            continue;
        };
        let ok_sig = verify_manifest(&trust, &signed, 2)
            .map(|v| v.status == ReleaseStatus::ReleaseVerificada)
            .unwrap_or(false);
        if !ok_sig {
            println!("{tag}: RECUSA (assinatura)");
            continue;
        }
        // A comparacao do 1.1.63, por IGUALDADE.
        if signed.body.version == tag.trim_start_matches('v') {
            println!("{tag}: ACEITA  <-- e esta que baixa sozinho");
            println!("\nVEREDITO: qualquer usuario na 1.1.63 atualiza sem tocar em nada.");
            return;
        }
        println!("{tag}: recusa (versao \"{}\" != tag)", signed.body.version);
    }
    println!("\nVEREDITO: NENHUMA candidata serve — usuario ficaria preso.");
}
