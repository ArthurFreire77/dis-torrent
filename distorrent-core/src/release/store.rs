//! Cache de manifestos verificados e contador monotônico de segurança.
//!
//! Regra central: só entra no cache o que passou por `verify_manifest` com o
//! conjunto de confiança LOCAL. Manifesto recebido de peer não é confiável por
//! si; ele é re-verificado e, se passar, é guardado para uso offline.
//!
//! O estado é persistido no `kv` do SQLite que já existe (sem banco novo):
//! - `release.epoch_floor`  — maior epoch de segurança já aceita;
//! - `release.manifest.<hash>` — wire hex do manifesto assinado;
//! - `release.revoked`      — versões revogadas conhecidas (JSON array);
//! - `release.trust`        — conjunto de confiança após rotação (formato textual).

use std::collections::BTreeMap;

use super::manifest::SignedManifest;
use super::trust::{
    bootstrap_trust_set, parse_trust_set, verify_manifest, ReleaseStatus, TrustSet, TrustUpdate,
    VerifiedManifest,
};
use crate::{DistorrentError, Result};

pub const KV_FLOOR: &str = "release.epoch_floor";
pub const KV_TRUST: &str = "release.trust";
pub const KV_REVOKED: &str = "release.revoked";
pub const KV_MANIFEST_PREFIX: &str = "release.manifest.";
pub const MAX_CACHED_MANIFESTS: usize = 8;
pub const KV_PENDING_UPDATE: &str = "release.update_pending";

/// Persistência mínima: o engine e o atualizador já têm um `Store` SQLite.
pub trait KvStore: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> Result<()>;
    /// Enumeração é opcional: sem ela o cache não é recarregado entre boots,
    /// mas nada de segurança depende disso (o piso de epoch é uma chave só).
    fn list_prefix(&self, _prefix: &str) -> Vec<(String, String)> {
        Vec::new()
    }
}

#[derive(Debug, Clone, Default)]
pub struct ReleaseTrust {
    trust: Option<TrustSet>,
    epoch_floor: u64,
    revoked: Vec<String>,
    /// hash do manifesto → wire hex (só verificados).
    cache: BTreeMap<String, String>,
    /// Manifesto mais recente verificado (para o atualizador).
    latest: Option<VerifiedManifest>,
    /// Motivo de a verificação estar indisponível, quando estiver.
    unavailable: Option<String>,
}

impl ReleaseTrust {
    pub fn empty(reason: &str) -> Self {
        Self {
            unavailable: Some(reason.to_string()),
            ..Default::default()
        }
    }

    /// Constrói um estado com um conjunto de confiança explícito. Usado pelo
    /// app depois da cerimônia e pelos testes de integração; não é caminho de
    /// produção para "confiar em qualquer coisa".
    pub fn with_trust(trust: TrustSet) -> Self {
        let unavailable = None;
        Self {
            trust: Some(trust),
            unavailable,
            ..Default::default()
        }
    }

    /// Carrega do armazenamento local, caindo para o conjunto embutido.
    pub fn load(kv: &dyn KvStore) -> Self {
        let trust = kv
            .get(KV_TRUST)
            .and_then(|raw| parse_trust_set(&raw).ok())
            .or_else(|| bootstrap_trust_set().ok());
        let epoch_floor = kv
            .get(KV_FLOOR)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let revoked: Vec<String> = kv
            .get(KV_REVOKED)
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let mut cache = BTreeMap::new();
        let mut latest: Option<VerifiedManifest> = None;
        for (k, v) in kv_prefix(kv, KV_MANIFEST_PREFIX) {
            let Some(hash) = k.strip_prefix(KV_MANIFEST_PREFIX) else {
                continue;
            };
            let Ok(wire) = hex::decode(&v) else {
                continue;
            };
            let Ok(signed) = SignedManifest::from_wire(&wire) else {
                continue;
            };
            if hash != signed.body.hash_hex().unwrap_or_default() {
                continue;
            }
            cache.insert(hash.to_string(), v);
            if let Some(t) = &trust {
                // Re-verifica no carregamento: cache adulterado no disco não
                // vira confiança só porque está gravado.
                if let Ok(vm) = verify_manifest(t, &signed, epoch_floor) {
                    if vm.is_verified()
                        && latest.as_ref().map_or(true, |l| {
                            vm.manifest.body.security_epoch >= l.manifest.body.security_epoch
                        })
                    {
                        latest = Some(vm);
                    }
                }
            }
        }
        let unavailable = trust
            .is_none()
            .then(|| "sem chaves de confiança embutidas (cerimônia não executada)".to_string());
        Self {
            trust,
            epoch_floor,
            revoked,
            cache,
            latest,
            unavailable,
        }
    }

    pub fn trust(&self) -> Option<&TrustSet> {
        self.trust.as_ref()
    }

    pub fn unavailable_reason(&self) -> Option<&str> {
        self.unavailable.as_deref()
    }

    pub fn verification_available(&self) -> bool {
        self.trust.is_some()
    }

    pub fn epoch_floor(&self) -> u64 {
        self.epoch_floor
    }

    pub fn latest_verified(&self) -> Option<&VerifiedManifest> {
        self.latest.as_ref()
    }

    pub fn revoked_versions(&self) -> &[String] {
        &self.revoked
    }

    pub fn is_revoked_version(&self, version: &str) -> bool {
        self.revoked.iter().any(|v| v == version)
    }

    /// Verifica e (se aprovado) guarda o manifesto. Devolve o veredito.
    pub fn accept(
        &mut self,
        kv: &dyn KvStore,
        signed: &SignedManifest,
    ) -> Result<VerifiedManifest> {
        let Some(trust) = self.trust.clone() else {
            return Ok(VerifiedManifest {
                manifest: signed.clone(),
                status: ReleaseStatus::NaoVerificado,
                valid_signatures: 0,
                manifest_hash: signed.body.hash_hex()?,
                trust_epoch: 0,
                reason: self
                    .unavailable
                    .clone()
                    .unwrap_or_else(|| "sem chaves de confiança".into()),
            });
        };
        let mut vm = verify_manifest(&trust, signed, self.epoch_floor)?;
        // Revogação conhecida localmente vale mesmo que o manifesto seja válido.
        if self.is_revoked_version(&vm.manifest.body.version) {
            vm.status = ReleaseStatus::Revogado;
            vm.reason = "versão revogada localmente".into();
        }
        if !vm.is_verified() {
            return Ok(vm);
        }
        let hash = vm.manifest_hash.clone();
        let wire = vm.manifest.to_wire()?;
        self.cache.insert(hash.clone(), hex::encode(wire));
        self.trim_cache(kv);
        let _ = kv.set(
            &format!("{KV_MANIFEST_PREFIX}{hash}"),
            &hex::encode(vm.manifest.to_wire()?),
        );
        if vm.manifest.body.security_epoch > self.epoch_floor {
            self.epoch_floor = vm.manifest.body.security_epoch;
            let _ = kv.set(KV_FLOOR, &self.epoch_floor.to_string());
        }
        // O manifesto pode exigir um piso MAIOR que a própria epoch? Não —
        // `min_security_epoch <= security_epoch` é validado. Mas ele pode
        // elevar o piso de um cliente que estava atrás, e isso vale para
        // releases futuras.
        if vm.manifest.body.min_security_epoch > self.epoch_floor {
            self.epoch_floor = vm.manifest.body.min_security_epoch;
            let _ = kv.set(KV_FLOOR, &self.epoch_floor.to_string());
        }
        for v in &vm.manifest.body.revoked_versions {
            if !self.revoked.iter().any(|r| r == v) {
                self.revoked.push(v.clone());
            }
        }
        self.revoked.sort();
        self.revoked.dedup();
        let _ = kv.set(
            KV_REVOKED,
            &serde_json::to_string(&self.revoked).unwrap_or_default(),
        );
        if self.latest.as_ref().map_or(true, |l| {
            vm.manifest.body.security_epoch >= l.manifest.body.security_epoch
        }) {
            self.latest = Some(vm.clone());
        }
        Ok(vm)
    }

    /// Aplica uma rotação de chaves assinada por 2-de-3 do conjunto atual.
    pub fn apply_rotation(&mut self, kv: &dyn KvStore, up: &TrustUpdate) -> Result<TrustSet> {
        let Some(current) = self.trust.clone() else {
            return Err(DistorrentError::Protocol(
                "release: sem conjunto de confiança para rotacionar".into(),
            ));
        };
        let new_set = up.verify_and_apply(&current)?;
        let raw = format!(
            "{}|{}|{}",
            new_set.epoch,
            new_set.threshold,
            new_set
                .keys
                .iter()
                .map(|k| format!("{}:{}", k.key_id, k.pubkey_hex))
                .collect::<Vec<_>>()
                .join(",")
        );
        kv.set(KV_TRUST, &raw)?;
        for v in &up.revoked_versions {
            if !self.revoked.iter().any(|r| r == v) {
                self.revoked.push(v.clone());
            }
        }
        self.revoked.sort();
        self.revoked.dedup();
        let _ = kv.set(
            KV_REVOKED,
            &serde_json::to_string(&self.revoked).unwrap_or_default(),
        );
        self.trust = Some(new_set.clone());
        Ok(new_set)
    }

    fn trim_cache(&mut self, kv: &dyn KvStore) {
        while self.cache.len() > MAX_CACHED_MANIFESTS {
            // BTreeMap não tem idade; remove o de menor hash (determinístico).
            if let Some(key) = self.cache.keys().next().cloned() {
                self.cache.remove(&key);
                let _ = kv.set(&format!("{KV_MANIFEST_PREFIX}{key}"), "");
            }
        }
    }
}

fn kv_prefix(kv: &dyn KvStore, prefix: &str) -> Vec<(String, String)> {
    kv.list_prefix(prefix)
}

#[cfg(test)]
mod tests {
    use super::super::trust::tests::{body, fixture, sign};
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemKv(Mutex<BTreeMap<String, String>>);

    impl KvStore for MemKv {
        fn get(&self, key: &str) -> Option<String> {
            self.0.lock().unwrap().get(key).cloned()
        }
        fn set(&self, key: &str, value: &str) -> Result<()> {
            let mut m = self.0.lock().unwrap();
            if value.is_empty() {
                m.remove(key);
            } else {
                m.insert(key.to_string(), value.to_string());
            }
            Ok(())
        }
    }

    fn trust_of(fixture: &super::super::trust::tests::Fixture) -> ReleaseTrust {
        ReleaseTrust {
            trust: Some(fixture.trust.clone()),
            ..Default::default()
        }
    }

    #[test]
    fn aceita_manifesto_valido_e_sobe_a_epoch() {
        let f = fixture();
        let kv = MemKv::default();
        let mut rt = trust_of(&f);
        let m = sign(&f, body(), &[0, 1]);
        let vm = rt.accept(&kv, &m).unwrap();
        assert!(vm.is_verified());
        assert_eq!(rt.epoch_floor(), 7);
        assert_eq!(kv.get(KV_FLOOR).unwrap(), "7");
    }

    #[test]
    fn manifesto_nao_verificado_nao_entra_no_cache() {
        let f = fixture();
        let kv = MemKv::default();
        let mut rt = trust_of(&f);
        let m = sign(&f, body(), &[0]);
        assert!(!rt.accept(&kv, &m).unwrap().is_verified());
        assert!(rt.latest_verified().is_none());
        assert!(kv.get(KV_FLOOR).is_none());
    }

    #[test]
    fn rollback_de_epoch_e_obsoleto_e_nao_abaixa_o_piso() {
        let f = fixture();
        let kv = MemKv::default();
        let mut rt = trust_of(&f);
        let m = sign(&f, body(), &[0, 1]);
        rt.accept(&kv, &m).unwrap();
        let mut velho = body();
        velho.security_epoch = 3;
        velho.min_security_epoch = 1;
        let m2 = sign(&f, velho, &[0, 1]);
        let vm = rt.accept(&kv, &m2).unwrap();
        assert_eq!(vm.status, ReleaseStatus::Obsoleto);
        assert_eq!(rt.epoch_floor(), 7);
    }

    #[test]
    fn revogacao_conhecida_vale_mesmo_com_assinatura_boa() {
        let f = fixture();
        let kv = MemKv::default();
        let mut rt = trust_of(&f);
        rt.revoked = vec!["1.2.3".into()];
        let m = sign(&f, body(), &[0, 1]);
        let vm = rt.accept(&kv, &m).unwrap();
        assert_eq!(vm.status, ReleaseStatus::Revogado);
    }

    #[test]
    fn rotacao_sem_2_de_3_e_recusada() {
        let f = fixture();
        let kv = MemKv::default();
        let mut rt = trust_of(&f);
        let novo = TrustSet {
            epoch: 2,
            threshold: 2,
            keys: f.trust.keys.clone(),
        };
        let sem_sig = TrustUpdate {
            from_epoch: 1,
            new_set: novo,
            revoked_versions: vec![],
            effective_ms: 1,
            reason: "teste".into(),
            signatures: vec![],
        };
        assert!(rt.apply_rotation(&kv, &sem_sig).is_err());
        assert_eq!(rt.trust().unwrap().epoch, 1);
    }

    #[test]
    fn sem_chaves_o_estado_e_indisponivel_e_nada_e_aceito() {
        let kv = MemKv::default();
        let f = fixture();
        let mut rt = ReleaseTrust::empty("sem chaves");
        let m = sign(&f, body(), &[0, 1]);
        let vm = rt.accept(&kv, &m).unwrap();
        assert_eq!(vm.status, ReleaseStatus::NaoVerificado);
        assert!(!rt.verification_available());
    }
}
