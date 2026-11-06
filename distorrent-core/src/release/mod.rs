//! Camada de autenticidade de releases e de builds.
//!
//! Separação que o resto do app precisa respeitar:
//!
//! - `ReleaseVerificada` comprova que o ARTEFATO foi autorizado por 2-de-3
//!   chaves e que os dados (versão, hash, URL, arquitetura) são os assinados.
//!   Não comprova que o processo em execução é aquele artefato.
//! - `AtestacaoDeHardware` só aparece quando existe prova de plataforma
//!   realmente verificável. Hoje nenhuma plataforma deste build produz uma, e a
//!   camada DIZ isso em vez de simular.
//! - `SelfIntegrityState` é a única coisa que fala do executável local, e é
//!   medida aqui, não declarada pela UI.

pub mod attestation;
pub mod manifest;
pub mod store;
pub mod trust;
pub mod trust_keys;

pub use attestation::{
    frame_allowed_in_quarantine, verify_attestation, BuildAttestation, BuildClaim, HardwareStatus,
    PeerPolicy, PeerTrust, PeerTrustState, SelfIntegrityState, ATTEST_PROTO_V, ATTEST_TIMEOUT_MS,
};
pub use manifest::{
    ManifestAsset, ManifestBody, ManifestSignature, SignedManifest, MANIFEST_SCHEMA,
    MAX_MANIFEST_BYTES, PROJECT_ID,
};
pub use store::{KvStore, ReleaseTrust};
pub use trust::{
    bootstrap_trust_set, encode_trust_update, parse_trust_set, verify_manifest, ReleaseStatus,
    TrustSet, TrustUpdate, TrustedKey, VerifiedManifest,
};
