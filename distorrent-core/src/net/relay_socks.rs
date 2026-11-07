// Relay socks: parte de net/relay.rs.
// Irmao do relay.rs; usa os tipos la declarados via super::*.

use super::*;

pub fn move_spawn_tunnel(
    listener: std::net::TcpListener,
    proxy: String,
    target: crate::net::socks5::SocksTarget,
) {
    std::thread::spawn(move || loop {
        match listener.accept() {
            Ok((down, _)) => {
                let (proxy, target) = (proxy.clone(), target.clone());
                std::thread::spawn(move || {
                    forward_via_socks(down, &proxy, &target).ok();
                });
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    });
}

pub fn forward_via_socks(
    down: std::net::TcpStream,
    proxy: &str,
    target: &crate::net::socks5::SocksTarget,
) -> std::io::Result<()> {
    let up = crate::net::socks5::socks5_connect_sync(proxy, target).map_err(|e| {
        tracing::debug!(%proxy, "túnel socks: circuito não abriu ({e})");
        std::io::Error::other(e.to_string())
    })?;
    down.set_nodelay(true).ok();
    up.set_nodelay(true).ok();
    let mut down_c = down.try_clone()?;
    let mut up_c = up.try_clone()?;
    let uplink = std::thread::spawn(move || {
        let _ = std::io::copy(&mut down_c, &mut up_c);
    });
    let mut down = down;
    let mut up = up;
    let _ = std::io::copy(&mut up, &mut down);
    let _ = up.shutdown(std::net::Shutdown::Both);
    let _ = down.shutdown(std::net::Shutdown::Both);
    uplink.join().ok();
    Ok(())
}

impl SocksTunnel {
    pub fn spawn(proxy: String, target_host: String, target_port: u16) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback túnel");
        let local_addr = listener.local_addr().expect("local_addr túnel");
        let target = crate::net::socks5::SocksTarget::Host(target_host, target_port);
        move_spawn_tunnel(listener, proxy, target);
        Self { local_addr }
    }
}
