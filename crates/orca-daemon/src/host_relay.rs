//! Windows: lets containers in Orca's WSL engine reach dev servers on
//! Windows that listen on `localhost` only, as Docker Desktop does.
//!
//! Containers reach Windows at `host.docker.internal`, which Orca maps to
//! Windows' address on WSL's virtual network. A dev server bound to
//! `localhost` isn't on that network, so for each port a gateway route sends
//! to `host.docker.internal`, the daemon listens on that address and passes
//! connections on to the server on `127.0.0.1` or `::1` (Node and Vite often
//! listen on `::1` only).
//!
//! Only while it's needed: the relay listens when the server answers on
//! localhost but not on WSL's address, and stops when the server does. So a
//! server started later on every interface finds the port free, and one
//! that already listens there is reached directly.

use std::collections::BTreeSet;

use orca_core::config::OrcaConfig;

/// The name containers reach Windows by.
const HOST: &str = "host.docker.internal";

/// The ports gateway routes send to dev servers on this computer.
pub fn host_ports(config: &OrcaConfig) -> BTreeSet<u16> {
    config
        .gateway
        .routes
        .iter()
        .filter(|r| r.enabled && r.container_name.eq_ignore_ascii_case(HOST))
        .map(|r| r.port)
        .collect()
}

/// Keep a relay listening for every routed host port, checking every few
/// seconds for routes added or removed and for Windows' address changing.
#[cfg(windows)]
pub async fn run(state: std::sync::Arc<crate::state::AppState>) {
    use std::collections::BTreeMap;
    use tokio::task::JoinHandle;

    let mut relays: BTreeMap<u16, JoinHandle<()>> = BTreeMap::new();
    let mut bound_ip: Option<String> = None;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let ip = crate::gateway::windows_host_ip();
        if ip != bound_ip {
            for (_, t) in std::mem::take(&mut relays) {
                t.abort();
            }
            bound_ip = ip.clone();
        }
        let Some(ip) = ip else { continue };
        let want = host_ports(&*state.config.lock().await);
        let mut keep = BTreeMap::new();
        for (port, t) in std::mem::take(&mut relays) {
            // Gone from the routes, or the server stopped: let the port go.
            if want.contains(&port) && !t.is_finished() && local_server(port).await.is_some() {
                keep.insert(port, t);
            } else {
                t.abort();
            }
        }
        relays = keep;
        for port in want {
            if relays.contains_key(&port) || local_server(port).await.is_none() {
                continue;
            }
            if answers(&ip, port).await {
                continue; // listens on every interface: reachable as it is
            }
            match crate::listen((ip.as_str(), port)) {
                Ok(listener) => {
                    tracing::info!("Relaying {ip}:{port} to Windows' localhost:{port} for containers");
                    relays.insert(port, tokio::spawn(relay(listener, port)));
                }
                Err(e) => tracing::info!("Could not relay port {port} for containers: {e}"),
            }
        }
    }
}

/// Where a server on this computer's localhost answers for `port`.
#[cfg(windows)]
async fn local_server(port: u16) -> Option<std::net::SocketAddr> {
    for addr in [
        std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port)),
    ] {
        if answers_at(addr).await {
            return Some(addr);
        }
    }
    None
}

#[cfg(windows)]
async fn answers(ip: &str, port: u16) -> bool {
    match ip.parse::<std::net::IpAddr>() {
        Ok(ip) => answers_at(std::net::SocketAddr::new(ip, port)).await,
        Err(_) => false,
    }
}

#[cfg(windows)]
async fn answers_at(addr: std::net::SocketAddr) -> bool {
    matches!(
        tokio::time::timeout(std::time::Duration::from_millis(500), tokio::net::TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

#[cfg(windows)]
async fn relay(listener: tokio::net::TcpListener, port: u16) {
    loop {
        let (mut inbound, _) = match listener.accept().await {
            Ok(c) => c,
            Err(e) => {
                // Out of handles, or the WSL adapter went away: don't spin.
                tracing::debug!("Relay for port {port}: {e}");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
        };
        tokio::spawn(async move {
            if let Some(addr) = local_server(port).await
                && let Ok(mut out) = tokio::net::TcpStream::connect(addr).await
            {
                let _ = tokio::io::copy_bidirectional(&mut inbound, &mut out).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orca_core::config::GatewayRoute;

    #[test]
    fn relays_the_ports_routed_to_this_computer() {
        let mut c = OrcaConfig::default();
        let route = |name: &str, port: u16, enabled: bool| {
            let mut r: GatewayRoute = serde_json::from_value(serde_json::json!({
                "hostname": format!("{name}.localhost"),
                "container_name": name,
                "port": port,
            }))
            .unwrap();
            r.enabled = enabled;
            r
        };
        c.gateway.routes = vec![
            route("host.docker.internal", 3000, true),
            route("host.docker.internal", 5173, false),
            route("shop-web-1", 80, true),
            route("HOST.docker.internal", 8000, true),
        ];
        assert_eq!(host_ports(&c), BTreeSet::from([3000, 8000]));
    }
}
