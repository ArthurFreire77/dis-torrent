// stats_aggregation_tests de media_voice.rs (extraido para o arquivo nao passar de 1.000 linhas).

use super::*;
#[cfg(test)]
use super::{aggregate_stats, VoiceStats};

fn peer(state: &str, source: Option<&str>, frames_out: u64) -> VoiceStats {
    VoiceStats {
        state: "connected".into(),
        route: "LAN".into(),
        jitter_depth_ms: 50,
        packets_in: 2,
        packets_out: 3,
        write_errors: 0,
        plc_frames: 0,
        decode_errors: 0,
        rtt_ms: Some(10),
        mic_error: None,
        speaker_error: None,
        video_state: Some(state.into()),
        video_codec: source.map(|_| "video/VP8".into()),
        video_source: source.map(str::to_owned),
        video_error: None,
        video_packets_in: Some(4),
        frames_in: Some(5),
        frames_out: Some(frames_out),
        peers_connected: None,
        peers_total: None,
    }
}

#[test]
fn aggregate_prefers_live_video_and_sums_peer_counters() {
    let stats = aggregate_stats([peer("off", None, 0), peer("live", Some("screen"), 7)])
        .expect("duas sessões devem produzir stats");

    assert_eq!(stats.video_state.as_deref(), Some("live"));
    assert_eq!(stats.video_source.as_deref(), Some("screen"));
    assert_eq!(stats.frames_out, Some(7));
    assert_eq!(stats.video_packets_in, Some(8));
    assert_eq!(stats.frames_in, Some(10));
    assert_eq!(stats.packets_in, 4);
    assert_eq!(stats.packets_out, 6);
}

#[test]
fn aggregate_reports_failed_video_when_no_peer_is_live_or_starting() {
    let stats = aggregate_stats([peer("off", None, 0), peer("failed", Some("camera"), 0)])
        .expect("duas sessões devem produzir stats");

    assert_eq!(stats.video_state.as_deref(), Some("failed"));
    assert_eq!(stats.video_source.as_deref(), Some("camera"));
}

#[test]
fn aggregate_does_not_double_count_the_worst_peer() {
    let mut primeiro = peer("off", None, 1);
    primeiro.state = "connected".into();
    primeiro.packets_in = 10;
    primeiro.packets_out = 20;
    let mut pior = peer("failed", Some("screen"), 3);
    pior.state = "failed".into();
    pior.packets_in = 1;
    pior.packets_out = 2;

    let stats = aggregate_stats([primeiro, pior]).expect("stats");
    assert_eq!(stats.state, "failed");
    assert_eq!(stats.packets_in, 11, "cada peer conta uma vez só");
    assert_eq!(stats.packets_out, 22);
}

#[test]
fn aggregate_counts_connected_peers_so_one_bad_peer_does_not_kill_the_call() {
    let mut a = peer("off", None, 0);
    a.state = "connected".into();
    let mut b = peer("off", None, 0);
    b.state = "failed".into();
    let mut c = peer("off", None, 0);
    c.state = "connected".into();

    let stats = aggregate_stats([a, b, c]).expect("três sessões produzem stats");
    assert_eq!(
        stats.state, "failed",
        "o pior par continua mandando no estado"
    );
    assert_eq!(stats.peers_connected, Some(2));
    assert_eq!(stats.peers_total, Some(3));
}

#[test]
fn aggregate_reports_zero_connected_only_when_nobody_is_up() {
    let mut a = peer("off", None, 0);
    a.state = "failed".into();
    let mut b = peer("off", None, 0);
    b.state = "connecting".into();

    let stats = aggregate_stats([a, b]).expect("duas sessões produzem stats");
    assert_eq!(stats.peers_connected, Some(0));
    assert_eq!(stats.peers_total, Some(2));
}

#[test]
fn aggregate_of_nothing_is_none_and_does_not_invent_zero_of_zero() {
    assert!(aggregate_stats(Vec::<VoiceStats>::new()).is_none());
}
