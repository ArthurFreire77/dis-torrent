//! Cofre local: a senha do usuário criptografa a chave privada no device.
//! Sem servidor, sem reset remoto — quem tem a senha, tem a identidade.
//! KDF: Argon2id (OWASP: m=19MiB, t=2, p=1) → ChaCha20Poly1305.

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use rand::RngCore;

use crate::{ForgeError, Result};

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

/// blob = salt(16) || nonce(12) || ciphertext
pub fn seal_secret(secret_hex: &str, password: &str) -> Result<Vec<u8>> {
    if password.len() < 8 {
        return Err(ForgeError::Crypto(
            "senha muito curta (mínimo 8 caracteres)".into(),
        ));
    }
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive_key(password, &salt)?;
    let cipher = ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(&key));
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: secret_hex.as_bytes(),
                aad: b"distorent/vault",
            },
        )
        .map_err(|_| ForgeError::Crypto("falha ao cifrar cofre".into()))?;
    let mut blob = Vec::with_capacity(SALT_LEN + NONCE_LEN + ct.len());
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    Ok(blob)
}

pub fn open_sealed(blob: &[u8], password: &str) -> Result<String> {
    if blob.len() < SALT_LEN + NONCE_LEN + 16 {
        return Err(ForgeError::Crypto("cofre corrompido".into()));
    }
    let (salt, rest) = blob.split_at(SALT_LEN);
    let (nonce, ct) = rest.split_at(NONCE_LEN);
    let key = derive_key(password, salt)?;
    let cipher = ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(&key));
    let pt = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ct,
                aad: b"distorent/vault",
            },
        )
        .map_err(|_| ForgeError::Crypto("senha incorreta".into()))?;
    String::from_utf8(pt).map_err(|_| ForgeError::Crypto("cofre corrompido".into()))
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32]> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(19_456, 2, 1, Some(32))
        .map_err(|e| ForgeError::Crypto(format!("argon2 params: {e}")))?;
    let a2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut okm = [0u8; 32];
    a2.hash_password_into(password.as_bytes(), salt, &mut okm)
        .map_err(|e| ForgeError::Crypto(format!("argon2: {e}")))?;
    Ok(okm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let secret = "ab".repeat(32);
        let blob = seal_secret(&secret, "minha-senha-123").unwrap();
        // blob não contém o segredo em claro
        assert!(!hex::encode(&blob).contains(&secret[..16]));
        let opened = open_sealed(&blob, "minha-senha-123").unwrap();
        assert_eq!(opened, secret);
    }

    #[test]
    fn wrong_password_fails() {
        let blob = seal_secret("cd".repeat(32).as_str(), "correta123").unwrap();
        assert!(open_sealed(&blob, "errada").is_err());
    }

    #[test]
    fn tampered_blob_fails() {
        let mut blob = seal_secret("ef".repeat(32).as_str(), "senha1234").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;
        assert!(open_sealed(&blob, "senha1234").is_err());
    }
}
