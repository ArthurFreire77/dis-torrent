// Simula o cliente 1.1.63 contra as releases REAIS do GitHub: aplica a mesma
// sequencia de recusas do `escolher` antigo e diz qual release ele aceitaria.
// Uso: cargo run --example old_client_sim -- <manifest da candidata>
use distorrent_core::release::manifest::SignedManifest;
use distorrent_core::release::trust::{bootstrap_trust_set, verify_manifest, ReleaseStatus};

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("uso: old_client_sim <manifest.bin> <tag>");
    let tag = std::env::args().nth(2).expect("tag");
    let bytes = std::fs::read(&path).expect("ler manifesto");
    let signed = match SignedManifest::from_wire(&bytes) {
        Ok(s) => s,
        Err(e) => {
            println!("1) from_wire          : RECUSA ({e})");
            return;
        }
    };
    println!("1) from_wire          : OK");
    let trust = bootstrap_trust_set().expect("trust");
    let vm = match verify_manifest(&trust, &signed, 2) {
        Ok(v) => v,
        Err(e) => {
            println!("2) assinatura         : RECUSA ({e})");
            return;
        }
    };
    let ok_sig = vm.status == ReleaseStatus::ReleaseVerificada;
    println!(
        "2) assinatura         : {} ({} validas)",
        if ok_sig { "OK" } else { "RECUSA" },
        vm.valid_signatures
    );
    if !ok_sig {
        println!("   motivo: {}", vm.reason);
        return;
    }
    // A comparacao QUE TINHA O BUG, exatamente como o 1.1.63 fazia.
    let tag_limpa = tag.trim_start_matches('v');
    let passa = signed.body.version == tag_limpa;
    println!(
        "3) versao == tag      : {} (manifesto \"{}\" x tag \"{}\")",
        if passa { "OK" } else { "RECUSA" },
        signed.body.version,
        tag_limpa
    );
    if passa {
        println!("\nVEREDITO: o cliente 1.1.63 ACEITA esta release e baixa sozinho.");
    } else {
        println!("\nVEREDITO: o cliente 1.1.63 RECUSA (bug de igualdade de versao).");
    }
}
