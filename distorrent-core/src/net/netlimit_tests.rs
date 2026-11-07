// Testes do limitador de rede (buckets por peer/rota).
// Ficam num arquivo irmao, declarado por #[path] em netlimit.rs.

use super::*;
use super::*;
use std::time::Duration;

fn limiter() -> NetLimiter {
    let l = NetLimiter {
        limits: Mutex::new(Limits::default()),
        tcp_accept_ip: Mutex::new(KeyedBuckets::new(30, 20)),
        tcp_accept_global: Mutex::new(GlobalBucket::new(120, 80)),
        disc_udp_ip: Mutex::new(KeyedBuckets::new(15, 10)),
        disc_udp_global: Mutex::new(GlobalBucket::new(300, 200)),
        relay_hello: Mutex::new(KeyedBuckets::new(12, 8)),
        frames_ip: Mutex::new(KeyedBuckets::new(1200, 800)),
        frames_kill_ip: Mutex::new(KeyedBuckets::new(6000, 6000)),
        bytes_ip: Mutex::new(KeyedBuckets::new(128 * 1024 * 1024, 64 * 1024 * 1024)),
        bytes_kill_ip: Mutex::new(KeyedBuckets::new(640 * 1024 * 1024, 640 * 1024 * 1024)),
        frames_global: Mutex::new(GlobalBucket::new(6000, 4000)),
        chunk_req: Mutex::new(KeyedBuckets::new(200, 120)),
        call_sig: Mutex::new(KeyedBuckets::new(240, 160)),
        friend_req: Mutex::new(KeyedBuckets::new(20, 12)),
        join_attempt: Mutex::new(KeyedBuckets::new(6, 3)),
        attest: Mutex::new(KeyedBuckets::new(10, 6)),
        manifest_push: Mutex::new(KeyedBuckets::new(4, 2)),
        attest_fail: Mutex::new(KeyedBuckets::new(3, 2)),
        handshake_slots: Slots::new(64),
        dial_slots: Slots::new(64),
        attest_slots: Slots::new(16),
        rejected: Mutex::new(RejectedCounters::default()),
    };
    l
}

#[test]
fn bucket_burst_e_refill_deslizante() {
    let mut b = KeyedBuckets::new(10, 3);
    let t0 = Instant::now();
    assert!(b.check_at("a", 1.0, t0));
    assert!(b.check_at("a", 1.0, t0));
    assert!(b.check_at("a", 1.0, t0));
    assert!(!b.check_at("a", 1.0, t0));
    let t1 = t0 + Duration::from_secs(10);
    assert!(b.check_at("a", 1.0, t1));
    assert!(b.check_at("a", 1.0, t1));
    assert!(b.check_at("a", 1.0, t1));
    assert!(!b.check_at("a", 1.0, t1));
}

#[test]
fn bucket_bytes_consome_em_unidades() {
    let mut b = KeyedBuckets::new(100, 250);
    let t0 = Instant::now();
    assert!(b.check_at("p", 128.0, t0));
    assert!(!b.check_at("p", 128.0, t0));
}

#[test]
fn frames_throttle_descarta_e_kill_encerra() {
    let l = limiter();
    let mut cfg = Limits::default();
    cfg.frames_per_peer_10s = 10;
    cfg.frames_per_peer_burst = 5;
    cfg.frames_kill_per_peer_10s = 20;
    l.reconfigure(cfg);
    let t0 = Instant::now();
    let mut drops = 0;
    let mut kills = 0;
    for i in 0..50 {
        match l.allow_frame_in_at("peerX", 100, t0 + Duration::from_millis(i)) {
            FrameVerdict::Allow => {}
            FrameVerdict::Drop(_) => drops += 1,
            FrameVerdict::Kill(_) => kills += 1,
        }
    }
    assert!(drops > 0, "deveria ter drops (throttle)");
    assert!(kills > 0, "deveria ter kills (flood)");
}

#[test]
fn slots_cap_e_release() {
    let s = Slots::new(2);
    let g1 = try_slot(&s).expect("1ª vaga");
    let _g2 = try_slot(&s).expect("2ª vaga");
    assert!(try_slot(&s).is_none(), "3ª vaga tem que falhar no cap 2");
    drop(g1);
    assert!(try_slot(&s).is_some(), "Drop liberou a vaga");
}

#[test]
fn esquecer_peer_devolve_o_burst() {
    let l = limiter();
    let mut cfg = Limits::default();
    cfg.relay_hello_per_peer_10s = 1;
    cfg.relay_hello_burst = 1;
    l.reconfigure(cfg);
    assert_eq!(l.allow_relay_hello("p"), Decision::Allowed);
    assert_eq!(
        l.allow_relay_hello("p"),
        Decision::Blocked,
        "burst 1 já foi consumido"
    );
    l.forget_peer("p");
    assert_eq!(
        l.allow_relay_hello("p"),
        Decision::Allowed,
        "esquecer zera o bucket do peer"
    );
}

#[test]
fn snapshot_conta_rejeicoes() {
    let l = limiter();
    let mut cfg = Limits::default();
    cfg.tcp_accept_per_ip_10s = 1;
    cfg.tcp_accept_burst = 1;
    l.reconfigure(cfg);
    let ip: IpAddr = "127.0.0.1".parse().unwrap();
    assert_eq!(l.allow_tcp_accept(ip), Decision::Allowed);
    assert_eq!(l.allow_tcp_accept(ip), Decision::Blocked);
    let snap = l.snapshot();
    assert_eq!(snap.rejected.tcp_accept, 1);
    assert_eq!(snap.limits.tcp_accept_burst, 1);
}

#[test]
fn env_num_usa_default_quando_ausente_ou_invalido() {
    assert_eq!(env_num::<u32>("DISTORRENT_LIMIT_TESTE_INEXISTENTE", 42), 42);
    assert_eq!(env_num::<u32>("DISTORRENT_LIMIT_TESTE_INEXISTENTE_2", 7), 7);
}

#[test]
fn discovery_udp_limita_por_origem() {
    let l = limiter();
    let mut cfg = Limits::default();
    cfg.disc_udp_per_ip_10s = 2;
    cfg.disc_udp_burst = 2;
    l.reconfigure(cfg);
    let ip: IpAddr = "192.168.0.10".parse().unwrap();
    assert_eq!(l.allow_disc_datagram(ip), Decision::Allowed);
    assert_eq!(l.allow_disc_datagram(ip), Decision::Allowed);
    assert_eq!(l.allow_disc_datagram(ip), Decision::Blocked);
    let ip2: IpAddr = "192.168.0.11".parse().unwrap();
    assert_eq!(l.allow_disc_datagram(ip2), Decision::Allowed);
}
