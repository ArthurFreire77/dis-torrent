// Verifica um distorrent-manifest.bin com o MESMO codigo do cliente
// (bootstrap_trust_set + SignedManifest::from_wire + verify_manifest).
// Uso: cargo run --example verify_manifest -- <manifest.bin>
use distorrent_core::release::manifest::SignedManifest;
use distorrent_core::release::trust::{bootstrap_trust_set, verify_manifest, ReleaseStatus};

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("uso: verify_manifest <distorrent-manifest.bin>");
    let bytes = std::fs::read(&path).expect("ler manifesto");
    let signed = match SignedManifest::from_wire(&bytes) {
        Ok(s) => s,
        Err(e) => {
            println!("from_wire FALHOU: {e}");
            std::process::exit(1);
        }
    };
    println!("versao no manifesto : {}", signed.body.version);
    println!("security_epoch      : {}", signed.body.security_epoch);
    println!("min_security_epoch  : {}", signed.body.min_security_epoch);
    println!("commit              : {}", signed.body.commit);
    println!("assets              : {}", signed.body.assets.len());
    println!("assinaturas         : {}", signed.signatures.len());

    let trust = match bootstrap_trust_set() {
        Ok(t) => t,
        Err(e) => {
            println!("trust set FALHOU: {e}");
            std::process::exit(1);
        }
    };
    let floor = std::env::args()
        .nth(2)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    println!("epoch_floor local   : {floor}\n");

    match verify_manifest(&trust, &signed, floor) {
        Ok(vm) => {
            println!("status              : {:?}", vm.status);
            println!("assinaturas validas : {}", vm.valid_signatures);
            println!("manifest_hash       : {}", vm.manifest_hash);
            println!("motivo              : {}", vm.reason);
            let ok = vm.status == ReleaseStatus::ReleaseVerificada;
            println!("\nVEREDITO: {}", if ok { "ACEITO" } else { "RECUSADO" });
            if !ok {
                std::process::exit(2);
            }
        }
        Err(e) => {
            println!("verify_manifest ERRO: {e}");
            std::process::exit(2);
        }
    }
}
