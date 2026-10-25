//! Windows: lets containers in Orca's WSL engine reach dev servers on
//! Windows that listen on `localhost` only, as Docker Desktop does.
//!
//! Containers reach Windows at `host.docker.internal`, which Orca maps to
//! Windows' address on WSL's virtual network. A dev server bound to
//! `127.0.0.1` isn't on that network, so for each port a gateway route sends
//! to `host.docker.internal`, the daemon listens on that address and passes
//! connections on to `127.0.0.1:<port>`. A server that already listens on
//! every interface keeps the port (binding it fails) and needs no relay.

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
        relays.retain(|port, t| {
            let keep = want.contains(port) && !t.is_finished();
            if !keep {
                t.abort();
            }
            keep
        });
        for port in want {
            if relays.contains_key(&port) {
                continue;
            }
            match tokio::net::TcpListener::bind((ip.as_str(), port)).await {
                Ok(listener) => {
                    tracing::info!("Relaying {ip}:{port} to Windows' localhost:{port} for containers");
                    relays.insert(port, tokio::spawn(relay(listener, port)));
                }
                // Something listens on every interface already: reachable as it is.
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {}
                Err(e) => tracing::debug!("Could not relay port {port}: {e}"),
            }
        }
    }
}

#[cfg(windows)]
async fn relay(listener: tokio::net::TcpListener, port: u16) {
    loop {
        let Ok((mut inbound, _)) = listener.accept().await else {
            continue;
        };
        tokio::spawn(async move {
            if let Ok(mut out) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
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
