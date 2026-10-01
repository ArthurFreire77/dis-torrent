//! Identidade criptográfica local (ed25519).
//! Fingerprint = primeiros 6 bytes de blake3(pubkey), hex (12 chars).
//! A chave privada nunca abandona este módulo serializada para a UI —
//! persistência é responsabilidade do chamador (keyring no app, arquivo no Host).

use blake3::Hasher;
use ed25519_dalek::{Signer, Verifier};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};

use crate::{ForgeError, Result};

pub const FINGERPRINT_LEN: usize = 12; // hex chars

#[derive(Clone)]
pub struct Keypair {
    secret: ed25519_dalek::SigningKey,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Identity {
    pub fingerprint: String,
    pub pubkey_hex: String,
    pub nickname: String,
    pub created_at: i64, // unix ms
}

impl Keypair {
    pub fn generate() -> Self {
        let mut csprng = OsRng;
        Self {
            secret: ed25519_dalek::SigningKey::generate(&mut csprng),
        }
    }

    pub fn from_secret_hex(hex_str: &str) -> Result<Self> {
        let bytes = hex::decode(hex_str.trim())
            .map_err(|e| ForgeError::Crypto(format!("secret hex inválido: {e}")))?;
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| ForgeError::Crypto("secret deve ter 32 bytes".into()))?;
        Ok(Self {
            secret: ed25519_dalek::SigningKey::from_bytes(&arr),
        })
    }

    pub fn secret_hex(&self) -> String {
        hex::encode(self.secret.to_bytes())
    }

    pub fn public_hex(&self) -> String {
        hex::encode(self.secret.verifying_key().to_bytes())
    }

    pub fn fingerprint(&self) -> String {
        fingerprint_of_pubkey_hex(&self.public_hex())
    }

    pub fn identity(&self, nickname: &str) -> Identity {
        Identity {
            fingerprint: self.fingerprint(),
            pubkey_hex: self.public_hex(),
            nickname: nickname.trim().to_string(),
            created_at: now_ms(),
        }
    }

    pub fn sign(&self, msg: &[u8]) -> String {
        hex::encode(self.secret.sign(msg).to_bytes())
    }

    pub fn verify(pubkey_hex: &str, msg: &[u8], sig_hex: &str) -> Result<bool> {
        let pk_bytes = hex::decode(pubkey_hex)
            .map_err(|e| ForgeError::Crypto(format!("pubkey hex inválido: {e}")))?;
        let arr: [u8; 32] = pk_bytes
            .try_into()
            .map_err(|_| ForgeError::Crypto("pubkey deve ter 32 bytes".into()))?;
        let vk = ed25519_dalek::VerifyingKey::from_bytes(&arr)
            .map_err(|e| ForgeError::Crypto(format!("pubkey inválida: {e}")))?;
        let sig_bytes = hex::decode(sig_hex)
            .map_err(|e| ForgeError::Crypto(format!("sig hex inválida: {e}")))?;
        let arr: [u8; 64] = sig_bytes
            .try_into()
            .map_err(|_| ForgeError::Crypto("sig deve ter 64 bytes".into()))?;
        let sig = ed25519_dalek::Signature::from_bytes(&arr);
        Ok(vk.verify(msg, &sig).is_ok())
    }
}

/// blake3(pubkey_bytes) → primeiros 12 hex chars. Corrige divergência TS/Rust.
pub fn fingerprint_of_pubkey_hex(pubkey_hex: &str) -> String {
    match hex::decode(pubkey_hex.trim()) {
        Ok(pub_bytes) if pub_bytes.len() == 32 => {
            hex::encode(blake3::hash(&pub_bytes).as_bytes())[..FINGERPRINT_LEN].to_string()
        }
        _ => {
            // fallback legado: hash do hex string puro (compat com identidades antigas)
            let mut h = Hasher::new();
            h.update(pubkey_hex.as_bytes());
            hex::encode(h.finalize().as_bytes())[..FINGERPRINT_LEN].to_string()
        }
    }
}

/// Verifica que pubkey pertence ao fingerprint (anti-spoof). Aceita tanto o novo
/// `blake3(pub_bytes)` quanto o legado `blake3(hex_str)` para compat com identidades antigas.
pub fn fingerprint_matches(fingerprint: &str, pubkey_hex: &str) -> bool {
    if fingerprint_of_pubkey_hex(pubkey_hex) == fingerprint {
        return true;
    }
    // compat legado: blake3(hex.as_bytes())
    let mut h = Hasher::new();
    h.update(pubkey_hex.as_bytes());
    let legacy = hex::encode(h.finalize().as_bytes())[..FINGERPRINT_LEN].to_string();
    legacy == fingerprint
}

/// legado para diagnóstico / testes
pub fn fingerprint_of_pubkey_hex_legacy(pubkey_hex: &str) -> String {
    let mut h = Hasher::new();
    h.update(pubkey_hex.as_bytes());
    hex::encode(h.finalize().as_bytes())[..FINGERPRINT_LEN].to_string()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keypair_roundtrip() {
        let kp = Keypair::generate();
        let fp = kp.fingerprint();
        assert_eq!(fp.len(), 12);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));

        let kp2 = Keypair::from_secret_hex(&kp.secret_hex()).unwrap();
        assert_eq!(kp2.public_hex(), kp.public_hex());
        assert_eq!(kp2.fingerprint(), fp);
    }

    #[test]
    fn sign_verify_ok_and_tamper_fail() {
        let a = Keypair::generate();
        let msg = b"forge-test-message";
        let sig = a.sign(msg);
        assert!(Keypair::verify(&a.public_hex(), msg, &sig).unwrap());

        // garante mutação: flip último char (se '0' vira '1', senão '0')
        let last = sig.chars().last().unwrap();
        let flipped = if last == '0' { '1' } else { '0' };
        let tampered = format!("{}{}", &sig[..sig.len() - 1], flipped);
        assert!(!Keypair::verify(&a.public_hex(), msg, &tampered).unwrap());
        assert!(!Keypair::verify(&a.public_hex(), b"other", &sig).unwrap());
    }

    #[test]
    fn fingerprint_binds_pubkey() {
        let a = Keypair::generate();
        let b = Keypair::generate();
        let fp = a.fingerprint();
        assert!(fingerprint_matches(&fp, &a.public_hex()));
        assert!(!fingerprint_matches(&fp, &b.public_hex()));
    }
}
