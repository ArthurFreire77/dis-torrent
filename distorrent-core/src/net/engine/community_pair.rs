// Pareamento imediato + push do estado do SERVIDOR.
//
// Dois buracos reais que este arquivo fecha:
//
// 1. `maintain_communities` discava os membros, mas com throttle de 45 s — abrir
//    o servidor na UI não iniciava nada na hora.
// 2. O estado (canais, cargos/tags, bots) só era empurrado quando o dono MEXIA
//    nele e o outro lado já estava Online. Quem entrava depois ficava com a
//    lista velha até o sync de 45 s: era o "criei a tag no PC e não apareceu no
//    celular".

use super::{EngineCmd, NetworkEngine};

impl NetworkEngine {
    /// Disca AGORA todos os membros do servidor (abrir o servidor ou o app).
    ///
    /// O throttle continua valendo, mas curto: repetir a chamada em cada render
    /// não vira rajada de announce/DHT.
    pub fn community_pair_now(&self, community_id: &str) {
        let me = self.identity.fingerprint.clone();
        if self.store.member_role(community_id, &me).is_none() {
            return; // não sou membro: não há com quem parear
        }
        let now = crate::identity::now_ms();
        for (fp, _, _) in self.store.list_members(community_id).unwrap_or_default() {
            if fp == me || self.link_tx(&fp).is_some() {
                continue;
            }
            self.connect_to_community_peer_throttled(&fp, now, 3_000);
        }
    }

    /// Servidores cujo estado EU devo empurrar para `peer_fp`.
    ///
    /// Só o DONO entra: ele é a autoridade do estado. Um membro empurrando a
    /// cópia dele (possivelmente velha) faria o receptor apagar canais/cargos
    /// novos no `community_full_sync`.
    fn state_targets_for(&self, peer_fp: &str) -> Vec<String> {
        let me = self.identity.fingerprint.clone();
        let mut out = Vec::new();
        for (cid, _name, owner) in self.store.list_communities().unwrap_or_default() {
            if owner != me {
                continue;
            }
            let membro = self
                .store
                .list_members(&cid)
                .map(|m| m.iter().any(|(fp, _, _)| fp == peer_fp))
                .unwrap_or(false);
            if membro {
                out.push(cid);
            }
        }
        out
    }

    /// Empurra o estado oficial para um peer que acabou de ficar Online.
    /// Sem isto o membro só via a tag nova no sync de até 45 s.
    pub fn flush_community_state_to(&self, peer_fp: &str) {
        if self.link_tx(peer_fp).is_none() {
            return;
        }
        for cid in self.state_targets_for(peer_fp) {
            if let Ok(frame) = self.community_state_payload(&cid, Some(peer_fp)) {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(peer_fp.to_string(), frame))
                    .ok();
            }
        }
    }

    /// Pede o estado agora, sem esperar o intervalo de 45 s do tique.
    /// Usado quando a UI volta ao primeiro plano (WebView do celular fica
    /// congelada e os eventos do intervalo se perdem).
    pub fn community_sync_now(&self, community_id: &str) {
        if self
            .store
            .member_role(community_id, &self.identity.fingerprint)
            .is_none()
        {
            return;
        }
        self.community_sync_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(community_id);
        self.request_community_sync(community_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::Keypair;
    use crate::storage::Store;
    use std::sync::Arc;

    fn mk_engine(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
        let kp = Keypair::generate();
        let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
        (e, dir)
    }

    /// Monta um servidor local com `owner` e os membros informados.
    fn seed_community(e: &Arc<NetworkEngine>, cid: &str, owner: &str, members: &[&str]) {
        let rows: Vec<(String, String, String)> = members
            .iter()
            .map(|fp| (fp.to_string(), format!("nick-{fp}"), "member".into()))
            .collect();
        let channels: Vec<crate::storage::ChannelMetaRow> = Vec::new();
        let roles: Vec<crate::storage::RoleRow> = Vec::new();
        let bots: Vec<crate::storage::BotRow> = Vec::new();
        let assignments: Vec<(String, Vec<String>)> = Vec::new();
        let meta = (String::new(), String::new(), String::new());
        e.store
            .community_full_sync(
                cid,
                "Servidor de teste",
                owner,
                &channels,
                &roles,
                &bots,
                &assignments,
                &rows,
                &meta,
            )
            .unwrap();
    }

    /// Abrir o servidor disca os membros NA HORA, sem esperar o tique de 15 s.
    #[test]
    fn pareamento_imediato_disca_membros() {
        let (e, _dir) = mk_engine("PairDono");
        let me = e.identity.fingerprint.clone();
        seed_community(&e, "cid-pair", &me, &[&me, "peer-par"]);
        let mut rx = e.cmd_rx.lock().unwrap().take().unwrap();

        e.community_pair_now("cid-pair");

        let mut viu_relay = false;
        while let Ok(cmd) = rx.try_recv() {
            if let EngineCmd::ConnectRelay(fp) = cmd {
                assert_eq!(fp, "peer-par", "disca o par, nunca a mim mesmo");
                viu_relay = true;
            }
        }
        assert!(viu_relay, "o pareamento imediato precisa enfileirar o dial");
    }

    /// Fora do servidor não existe pareamento (nem dial, nem frame).
    #[test]
    fn pareamento_de_servidor_alheio_e_no_op() {
        let (e, _dir) = mk_engine("PairForasteiro");
        let mut rx = e.cmd_rx.lock().unwrap().take().unwrap();
        e.community_pair_now("servidor-de-outra-pessoa");
        assert!(rx.try_recv().is_err(), "sem membros não há o que discar");
    }

    /// O dono tem autoridade sobre o próprio servidor; o membro comum, não.
    #[test]
    fn apenas_o_dono_empurra_estado() {
        let (e, _dir) = mk_engine("SyncDono");
        let me = e.identity.fingerprint.clone();
        seed_community(&e, "cid-meu", &me, &[&me, "peer-x"]);
        seed_community(&e, "cid-alheio", "dono-de-fora", &["dono-de-fora", &me]);

        let alvos = e.state_targets_for("peer-x");
        assert_eq!(alvos, vec!["cid-meu".to_string()]);
    }

    /// Peer que não é membro não recebe estado (nada de vazar estrutura).
    #[test]
    fn nao_empurra_estado_para_quem_nao_e_membro() {
        let (e, _dir) = mk_engine("SyncEstranho");
        let me = e.identity.fingerprint.clone();
        seed_community(&e, "cid-meu", &me, &[&me]);
        assert!(e.state_targets_for("peer-desconhecido").is_empty());
    }

    /// `community_sync_now` de servidor alheio não gasta frame nem registra
    /// rate-limit para um id que nem é meu.
    #[test]
    fn sync_agora_de_servidor_alheio_e_no_op() {
        let (e, _dir) = mk_engine("SyncForasteiro");
        e.community_sync_now("servidor-de-outra-pessoa");
        assert!(!e
            .community_sync_at
            .lock()
            .unwrap_or_else(|x| x.into_inner())
            .contains_key("servidor-de-outra-pessoa"));
    }
}
