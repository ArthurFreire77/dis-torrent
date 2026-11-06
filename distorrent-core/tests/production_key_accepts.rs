//! Prova de assinatura REAL com as chaves de produção do dono.
//!
//! O arquivo `tests/fixtures/signed_production_sample.bin` foi assinado por
//! `tools/release-trust/sign-release.mjs` usando 2 das 3 chaves da cerimônia
//! (as privadas vivem fora do repositório). Este teste prova que:
//!
//! 1. o manifesto assinado de verdade passa no `verify_manifest` do Rust com a
//!    raiz de confiança EMBUTIDA no binário (a mesma que os usuários terão);
//! 2. alterar qualquer byte do manifesto faz a verificação falhar;
//! 3. o mesmo arquivo com a assinatura de UMA chave é recusado.
//!
//! O fixture contém apenas dados públicos: manifesto, key_ids e assinaturas.

use distorrent_core::release::manifest::SignedManifest;
use distorrent_core::release::trust::{bootstrap_trust_set, verify_manifest, ReleaseStatus};

const AMOSTRA: &[u8] = include_bytes!("fixtures/signed_production_sample.bin");

fn raiz() -> distorrent_core::release::TrustSet {
    bootstrap_trust_set().expect("raiz de confiança precisa estar embutida neste build")
}

#[test]
fn manifesto_assinado_com_as_chaves_do_dono_e_aceito_pela_raiz_embutida() {
    let signed = SignedManifest::from_wire(AMOSTRA).expect("wire válido");
    let trust = raiz();
    let v = verify_manifest(&trust, &signed, 0).expect("verificação roda");
    assert_eq!(
        v.status,
        ReleaseStatus::ReleaseVerificada,
        "motivo: {}",
        v.reason
    );
    assert!(v.valid_signatures >= 2, "duas chaves distintas assinaram");
    assert_eq!(v.manifest_hash, signed.body.hash_hex().unwrap());
}

#[test]
fn adulterar_um_byte_do_manifesto_invalida_a_assinatura() {
    let mut copia = AMOSTRA.to_vec();
    // Acha o sha256 do asset (64 chars ASCII '0') e troca por 'e'.
    let alvo = vec![b'0'; 64];
    let pos = copia
        .windows(alvo.len())
        .position(|w| w == alvo.as_slice())
        .expect("sha256 do asset existe no wire");
    copia[pos] = b'e';
    let signed = SignedManifest::from_wire(&copia).expect("ainda decodifica");
    let v = verify_manifest(&raiz(), &signed, 0).unwrap();
    assert_eq!(
        v.status,
        ReleaseStatus::NaoVerificado,
        "manifesto adulterado não pode passar"
    );
}

#[test]
fn com_uma_assinatura_so_o_manifesto_nao_e_verificado() {
    let mut signed = SignedManifest::from_wire(AMOSTRA).unwrap();
    signed.signatures.truncate(1);
    let v = verify_manifest(&raiz(), &signed, 0).unwrap();
    assert_eq!(v.status, ReleaseStatus::NaoVerificado);
}

#[test]
fn raiz_embutida_tem_3_chaves_e_limiar_2() {
    let t = raiz();
    assert_eq!(t.threshold, 2);
    assert_eq!(t.keys.len(), 3);
    assert_eq!(t.epoch, 1);
}
