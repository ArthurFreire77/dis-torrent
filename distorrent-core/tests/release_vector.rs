//! Gera o vetor fixo que prova que o tooling Node e o Rust produzem EXATAMENTE
//! os mesmos bytes canônicos.
//!
//! Rodar com:
//!   cargo test --test release_vector -- --ignored --nocapture
//!
//! As sementes abaixo são de TESTE e estão marcadas com `secret-scan: allow`.
//! Elas assinam apenas o vetor de teste; nenhuma release publicada usa isto.
//! O JSON gerado NÃO contém segredo algum — só pubkeys e bytes.

use distorrent_core::identity::Keypair;
use distorrent_core::release::manifest::{
    ManifestAsset, ManifestBody, ManifestSignature, SignedManifest, MANIFEST_SCHEMA, PROJECT_ID,
};
use distorrent_core::release::trust::TrustedKey;

// secret-scan: allow (semente de teste; usada só para assinar o vetor)
const TEST_SEED_1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
// secret-scan: allow (semente de teste; usada só para assinar o vetor)
const TEST_SEED_2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn asset(name: &str, os: &str, arch: &str) -> ManifestAsset {
    ManifestAsset {
        name: name.into(),
        os: os.into(),
        arch: arch.into(),
        size: 1_234_567,
        sha256: "3f".repeat(32),
        url: format!(
            "https://github.com/ArthurFreire77/dis-torrent/releases/download/v1.2.3/{name}"
        ),
    }
}

#[test]
#[ignore = "gera o vetor de teste; roda manualmente"]
fn emitir_vetor() {
    let k1 = Keypair::from_secret_hex(TEST_SEED_1).unwrap();
    let k2 = Keypair::from_secret_hex(TEST_SEED_2).unwrap();

    let body = ManifestBody {
        schema: MANIFEST_SCHEMA,
        project: PROJECT_ID.into(),
        version: "1.2.3".into(),
        channel: "stable".into(),
        tag: "v1.2.3".into(),
        commit: "0123456789abcdef0123456789abcdef01234567".into(),
        published_at_ms: 1_700_000_000_000,
        protocol_version: 5,
        min_protocol_version: 4,
        security_epoch: 7,
        min_security_epoch: 3,
        revoked_versions: vec!["1.0.0".into(), "1.1.0".into()],
        revoked_key_ids: vec![],
        assets: vec![
            asset("DisTorrent_1.2.3_arm64.apk", "android", "aarch64"),
            asset("DisTorrent_1.2.3_amd64.AppImage", "linux", "x86_64"),
            asset("DisTorrent_1.2.3_x64_setup.exe", "windows", "x86_64"),
        ],
    };

    let payload = body.signing_payload().unwrap();
    let sig = |k: &Keypair| ManifestSignature {
        key_id: TrustedKey::from_pubkey_hex(&k.public_hex()).unwrap().key_id,
        sig: k.sign(&payload),
    };
    let signed = SignedManifest {
        signatures: vec![sig(&k1), sig(&k2)],
        body,
    };

    let trust_line = format!(
        "1|2|{}",
        [
            TrustedKey::from_pubkey_hex(&k1.public_hex()).unwrap(),
            TrustedKey::from_pubkey_hex(&k2.public_hex()).unwrap(),
        ]
        .iter()
        .map(|k| format!("{}:{}", k.key_id, k.pubkey_hex))
        .collect::<Vec<_>>()
        .join(",")
    );

    let out = serde_json::json!({
        "aviso": "vetor de teste; nenhum segredo aqui",
        "pubkey_1": k1.public_hex(),
        "pubkey_2": k2.public_hex(),
        "trust_set": trust_line,
        "canonical_hex": hex::encode(signed.body.canonical_bytes().unwrap()),
        "manifest_hash": signed.body.hash_hex().unwrap(),
        "wire_hex": hex::encode(signed.to_wire().unwrap()),
    });
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("release_vector.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
    println!("VETOR: {}", path.display());
    println!("manifest_hash: {}", out["manifest_hash"]);
}
