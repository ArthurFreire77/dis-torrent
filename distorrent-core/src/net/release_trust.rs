//! Ponte entre o `Store` SQLite existente e a camada de confiança de releases.
//!
//! Não cria banco nem tabela: usa o `kv` que já existe. `Store` é
//! `Arc`-compartilhado em todo o app, então a implementação só delega.

use std::sync::Arc;

use crate::release::{KvStore, ReleaseTrust};
use crate::storage::Store;
use crate::Result;

pub struct StoreKv(pub Arc<Store>);

/// Compara duas versões (`1.1.9` < `1.1.10`) pelo núcleo numérico.
///
/// POR QUE existe: o `ReleaseTrust` guarda vários manifestos e precisa dizer
/// qual é o mais novo. Comparar a string inverteria (`"1.1.9" > "1.1.10"`), e
/// comparar só a `security_epoch` empata entre releases da mesma linha.
pub fn versao_maior(a: &str, b: &str) -> bool {
    fn nucleo(v: &str) -> Vec<u64> {
        v.trim()
            .trim_start_matches(['v', 'V'])
            .split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    }
    let pa = nucleo(a);
    let pb = nucleo(b);
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

impl KvStore for StoreKv {
    fn get(&self, key: &str) -> Option<String> {
        self.0.kv_get(key)
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        if value.is_empty() {
            return self.0.kv_delete(key);
        }
        self.0.kv_set(key, value)
    }

    fn list_prefix(&self, prefix: &str) -> Vec<(String, String)> {
        self.0.kv_list_prefix(prefix).unwrap_or_default()
    }
}

/// Carrega o estado de confiança do banco local. Falha de leitura não vira
/// confiança: devolve `ReleaseTrust::empty` e o motivo.
pub fn load(store: &Arc<Store>) -> ReleaseTrust {
    let kv = StoreKv(Arc::clone(store));
    let loaded = ReleaseTrust::load(&kv);
    if !loaded.verification_available() {
        let reason = loaded
            .unavailable_reason()
            .unwrap_or("sem chaves de confiança")
            .to_string();
        return ReleaseTrust::empty(&reason);
    }
    loaded
}

/// Configuração de política de peer (persistida em `kv`).
pub const KV_PEER_POLICY: &str = "release.peer_policy";
/// Self-integrity medida no boot (persistida em `kv`).
pub const KV_SELF_INTEGRITY: &str = "release.self_integrity";

/// Identificador curto e reprodutível do build: blake3(pubkey da release? não —
/// da identidade local + versão + proto). É DECLARADO, não é prova.
pub fn build_id(pubkey_hex: &str, version: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"distorrent/v1|build-id|");
    h.update(pubkey_hex.as_bytes());
    h.update(b"|");
    h.update(version.as_bytes());
    h.update(b"|");
    h.update(crate::net::transport::PROTO_V.to_string().as_bytes());
    hex::encode(&h.finalize().as_bytes()[..16])
}

/// Mede o executável EM EXECUÇÃO contra o asset de binário do manifesto
/// verificado.
///
/// O que este número prova: os bytes do arquivo que abriu este processo são os
/// mesmos do asset assinado. O que NÃO prova: que o processo que está rodando
/// agora é esse arquivo (um atacante com escrita no disco poderia trocar o
/// arquivo depois do boot), nem que a memória não foi alterada. Não existe
/// atestação de runtime sem hardware/medido — e o estado diz isso.
pub fn self_integrity(store: &Store) -> crate::release::SelfIntegrityState {
    use crate::release::SelfIntegrityState as S;
    let Some(expected) = store.kv_get(KV_SELF_INTEGRITY) else {
        return S::Unavailable;
    };
    let expected = expected.trim().to_ascii_lowercase();
    if expected.len() != 64 {
        return S::Unavailable;
    }
    let Ok(exe) = std::env::current_exe() else {
        return S::Unavailable;
    };
    let Ok(bytes) = std::fs::read(&exe) else {
        return S::Unavailable;
    };
    use sha2::Digest as _;
    let got = hex::encode(sha2::Sha256::digest(&bytes));
    if got == expected {
        S::Confere
    } else {
        S::Diverge
    }
}

/// Grava o SHA-256 esperado do executável (chamado pelo atualizador depois de
/// validar um instalador; nunca pela UI).
pub fn set_expected_self_sha256(store: &Store, sha: &str) -> Result<()> {
    if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(crate::DistorrentError::Protocol(
            "release: sha256 do próprio binário inválido".into(),
        ));
    }
    store.kv_set(KV_SELF_INTEGRITY, &sha.to_ascii_lowercase())
}

pub fn peer_policy(store: &Store) -> crate::release::PeerPolicy {
    crate::release::PeerPolicy::parse(
        &store
            .kv_get(KV_PEER_POLICY)
            .unwrap_or_else(|| "block_revoked".to_string()),
    )
}

pub fn set_peer_policy(store: &Store, policy: &str) -> Result<()> {
    let parsed = crate::release::PeerPolicy::parse(policy);
    store.kv_set(KV_PEER_POLICY, parsed.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn politica_padrao_bloqueia_revogado_sem_quebrar_rede() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("t.db")).unwrap());
        assert_eq!(
            peer_policy(&store),
            crate::release::PeerPolicy::BlockRevoked
        );
        set_peer_policy(&store, "block_unverified").unwrap();
        assert_eq!(
            peer_policy(&store),
            crate::release::PeerPolicy::BlockUnverified
        );
        set_peer_policy(&store, "lixo-invalido").unwrap();
        assert_eq!(
            peer_policy(&store),
            crate::release::PeerPolicy::BlockRevoked,
            "valor inválido cai no padrão seguro"
        );
    }

    #[test]
    fn trust_load_sem_manifesto_nao_panica_e_usa_a_raiz_embutida() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("t.db")).unwrap());
        let rt = load(&store);
        assert!(rt.verification_available());
        assert!(rt.latest_verified().is_none());
        assert_eq!(rt.epoch_floor(), 0);
        assert!(rt.trust().unwrap().threshold >= 2);
    }
}
