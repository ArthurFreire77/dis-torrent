pub mod antispam;
pub mod authlimit;
pub mod bots;
pub mod cache;
pub mod group_trash;
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

/// blake3 do core, reexportado para a casca conferir integridade de arquivo
/// sem duplicar a dependência (e sem arriscar versões divergentes do hash).
pub use blake3;
pub use tokio::sync::broadcast::error::RecvError as BroadcastRecvError;
pub use tokio::sync::broadcast::error::TryRecvError as BroadcastTryRecvError;

#[derive(Debug, thiserror::Error)]
pub enum DistorrentError {
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

impl From<String> for DistorrentError {
    fn from(s: String) -> Self {
        DistorrentError::Social(s)
    }
}

pub type Result<T> = std::result::Result<T, DistorrentError>;
