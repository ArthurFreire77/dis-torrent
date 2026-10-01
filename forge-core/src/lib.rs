//! forge-core — motor do FORGE: identidade criptográfica, storage local (SQLite)
//! e rede P2P real (descoberta LAN + TCP autenticado + sessão cifrada).
//!
//! Este crate NÃO depende de Tauri, React ou UI. É usado por:
//! - o app desktop (src-tauri)
//! - o Community Host (headless, futuro)
//! - testes de integração (dois nós reais em localhost)

pub mod antispam;
pub mod authlimit;
pub mod cache;
pub mod identity;
pub mod media;
pub mod metrics;
pub mod moderation;
pub mod names;
pub mod net;
pub mod protocol;
pub mod social;
pub mod storage;
pub mod stormvault;
pub mod vault;

pub use identity::{Identity, Keypair};
pub use net::engine::{EngineEvent, NetworkEngine, NetworkState};
pub use protocol::{MessageEnvelope, SecureFrame};

#[derive(Debug, thiserror::Error)]
pub enum ForgeError {
    // A camada social (`social.rs`) devolve Result<_, String> para não depender
    // de ForgeError; converte-se em erro de protocolo na fronteira.
    #[error("protocol: {0}")]
    Social(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("crypto: {0}")]
    Crypto(String),
    #[error("storage: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("protocol: {0}")]
    Protocol(String),
    #[error("peer not connected: {0}")]
    PeerNotConnected(String),
    #[error("engine already started")]
    AlreadyStarted,
}

impl From<String> for ForgeError {
    fn from(s: String) -> Self {
        ForgeError::Social(s)
    }
}

pub type Result<T> = std::result::Result<T, ForgeError>;
