//! What a container's published ports speak, found by asking them: only when
//! someone asks (a "Check" button), never in the background.
//!
//! A server that speaks first (SSH, SMTP, MySQL…) is named from its greeting;
//! the rest get one plain `GET /`, and a web page is named by its `<title>`.

use std::time::Duration;

use orca_core::runtime::PortMapping;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Ports checked per request, so a container publishing hundreds (a TURN
/// relay range) costs no more than a few.
const MAX_PORTS: usize = 12;
const CONNECT: Duration = Duration::from_millis(1000);
/// How long a server gets to greet before it's sent a request.
const GREETING: Duration = Duration::from_millis(400);
const RESPONSE: Duration = Duration::from_millis(1500);
const MAX_READ: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PortKind {
    /// Answers HTTP: the gateway can serve it.
    Web,
    /// Answers, but not HTTP.
    Other,
    /// Nothing listens, or it didn't answer in time.
    NoAnswer,
    /// Not published on this computer, or UDP: not checked.
    NotChecked,
}

#[derive(Debug, Clone, Serialize)]
pub struct PortProbe {
    pub container_port: u16,
    pub protocol: String,
    pub kind: PortKind,
    /// What it is: a page title ("Grafana"), or a protocol ("PostgreSQL").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

/// Check the published TCP ports of a container whose Docker engine is at
/// `docker_host`.
pub async fn probe(docker_host: Option<&str>, ports: &[PortMapping]) -> Vec<PortProbe> {
    let host = engine_host(docker_host);
    let mut seen = std::collections::HashSet::new();
    let ports: Vec<&PortMapping> = ports
        .iter()
        .filter(|p| seen.insert((p.container_port, p.protocol.clone())))
        .collect();

    let mut checked = 0;
    let jobs = ports.into_iter().map(|p| {
        let checkable = p.protocol.eq_ignore_ascii_case("tcp") && p.host_port != 0 && checked < MAX_PORTS;
        if checkable {
            checked += 1;
        }
        let addr = (probe_ip(&host, p.host_ip.as_deref()), p.host_port);
        async move {
            let (kind, label, status) = if checkable {
                ask(&addr.0, addr.1).await
            } else {
                (PortKind::NotChecked, None, None)
            };
            PortProbe {
                container_port: p.container_port,
                protocol: p.protocol.to_lowercase(),
                kind,
                label,
                status,
            }
        }
    });
    futures::future::join_all(jobs.collect::<Vec<_>>()).await
}

/// The machine published ports are on: the engine's host for a remote one,
/// this computer otherwise (Docker Desktop and Lima forward to it).
fn engine_host(docker_host: Option<&str>) -> String {
    let Some(h) = docker_host else {
        return "127.0.0.1".into();
    };
    let rest = h
        .strip_prefix("tcp://")
        .or_else(|| h.strip_prefix("ssh://"))
        .unwrap_or("");
    let rest = rest.rsplit('@').next().unwrap_or(rest);
    let host = match rest.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => rest.split([':', '/']).next().unwrap_or(""),
    };
    if host.is_empty() {
        "127.0.0.1".into()
    } else {
        host.into()
    }
}

fn probe_ip(engine: &str, host_ip: Option<&str>) -> String {
    match host_ip {
        Some(ip) if engine == "127.0.0.1" && !ip.is_empty() && ip != "0.0.0.0" && ip != "::" => ip.to_string(),
        _ => engine.to_string(),
    }
}

async fn ask(host: &str, port: u16) -> (PortKind, Option<String>, Option<u16>) {
    let Some(mut stream) = connect(host, port).await else {
        return (PortKind::NoAnswer, None, None);
    };
    let mut buf = vec![0u8; 4096];
    if let Ok(Ok(n)) = tokio::time::timeout(GREETING, stream.read(&mut buf)).await {
        if n == 0 {
            return (PortKind::NoAnswer, None, None);
        }
        return (PortKind::Other, greeting_label(&buf[..n]), None);
    }

    let request = format!(
        "GET / HTTP/1.1\r\nHost: {host}:{port}\r\nUser-Agent: Orca\r\nAccept: text/html,*/*\r\nConnection: close\r\n\r\n"
    );
    let reply = exchange(stream, request.as_bytes()).await;
    if !reply.is_empty() {
        return match parse_http(&reply) {
            // An HTTPS server's complaint about plain HTTP: not one the gateway can serve.
            Some((_, Some(label))) if label == "HTTPS" => (PortKind::Other, Some(label), None),
            Some((status, label)) => (PortKind::Web, label, Some(status)),
            None => (PortKind::Other, reply_label(&reply), None),
        };
    }

    // It hung up on HTTP: a few servers answer only their own first message.
    for (hello, label) in HELLOS {
        let Some(stream) = connect(host, port).await else { break };
        let reply = exchange(stream, hello).await;
        if hello_answered(label, &reply) {
            return (PortKind::Other, Some(label.to_string()), None);
        }
    }
    (PortKind::NoAnswer, None, None)
}

/// First messages of servers that say nothing to an HTTP request.
const HELLOS: &[(&[u8], &str)] = &[
    // SSLRequest: PostgreSQL answers S or N.
    (&[0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f], "PostgreSQL"),
    (b"PING\r\n", "Redis"),
    // A STUN binding request (RFC 5389).
    (
        &[
            0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        ],
        "STUN/TURN",
    ),
];

fn hello_answered(label: &str, reply: &[u8]) -> bool {
    match label {
        "PostgreSQL" => reply == b"S" || reply == b"N",
        "Redis" => reply.starts_with(b"+PONG") || reply.starts_with(b"-NOAUTH") || reply.starts_with(b"-ERR"),
        _ => reply.len() >= 20 && reply[0] == 0x01 && reply[1] == 0x01 && reply[4..8] == [0x21, 0x12, 0xa4, 0x42],
    }
}

async fn connect(host: &str, port: u16) -> Option<TcpStream> {
    tokio::time::timeout(CONNECT, TcpStream::connect((host, port)))
        .await
        .ok()?
        .ok()
}

async fn exchange(mut stream: TcpStream, message: &[u8]) -> Vec<u8> {
    if stream.write_all(message).await.is_err() {
        return Vec::new();
    }
    read_reply(&mut stream).await
}

async fn read_reply(stream: &mut TcpStream) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = vec![0u8; 8192];
    let deadline = tokio::time::Instant::now() + RESPONSE;
    while out.len() < MAX_READ {
        match tokio::time::timeout_at(deadline, stream.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => out.extend_from_slice(&buf[..n]),
            _ => break,
        }
        if contains_ci(&out, b"</title>") {
            break;
        }
    }
    out
}

/// A server that greets before it's asked anything.
fn greeting_label(b: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(b);
    let label = if text.starts_with("SSH-") {
        "SSH"
    } else if text.starts_with("220") {
        if contains_ci(b, b"ftp") { "FTP" } else { "SMTP" }
    } else if text.starts_with("+OK") {
        "POP3"
    } else if text.starts_with("* OK") {
        "IMAP"
    } else if text.starts_with("INFO {") {
        "NATS"
    } else if b.len() > 5 && b[4] == 10 && contains_ci(b, b"mysql_native_password")
        || contains_ci(b, b"caching_sha2_password")
    {
        "MySQL"
    } else if b.len() > 5 && b[4] == 10 && contains_ci(b, b"mariadb") {
        "MariaDB"
    } else {
        return None;
    };
    Some(label.into())
}

/// A server's answer to an HTTP request it doesn't understand.
fn reply_label(b: &[u8]) -> Option<String> {
    let label = if b.first() == Some(&0x15) {
        "TLS"
    } else if b.first() == Some(&b'E') && contains_ci(b, b"SFATAL") {
        "PostgreSQL"
    } else if b.starts_with(b"-ERR") || b.starts_with(b"-NOAUTH") {
        "Redis"
    } else if b.starts_with(b"AMQP") {
        "AMQP"
    } else {
        return None;
    };
    Some(label.into())
}

/// The status, and the page's title when it's a page, of an HTTP response.
fn parse_http(b: &[u8]) -> Option<(u16, Option<String>)> {
    let text = String::from_utf8_lossy(b);
    let status: u16 = text.strip_prefix("HTTP/")?.split(' ').nth(1)?.parse().ok()?;
    let head = text.split("\r\n\r\n").next().unwrap_or("").to_ascii_lowercase();
    let header = |name: &str| {
        head.lines()
            .find_map(|l| l.strip_prefix(name).and_then(|v| v.strip_prefix(':')))
            .map(|v| v.trim().to_string())
    };
    let label = if status == 400 && contains_ci(b, b"https") {
        // An HTTPS server's complaint about plain HTTP.
        Some("HTTPS".into())
    } else if let Some(t) = title(&text) {
        Some(t)
    } else if header("content-type").is_some_and(|t| t.contains("json")) {
        Some("JSON API".into())
    } else {
        // "Server: nginx/1.27" names the server, if nothing else does.
        header("server")
            .and_then(|s| s.split(['/', ' ']).next().map(str::to_string))
            .filter(|s| !s.is_empty())
    };
    Some((status, label))
}

fn title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title>")?;
    let t = html[start..end]
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'");
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return None;
    }
    Some(if t.chars().count() > 60 {
        format!("{}…", t.chars().take(59).collect::<String>())
    } else {
        t
    })
}

fn contains_ci(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w.eq_ignore_ascii_case(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_greetings() {
        assert_eq!(greeting_label(b"SSH-2.0-OpenSSH_9.6\r\n").as_deref(), Some("SSH"));
        assert_eq!(
            greeting_label(b"220 mailpit ESMTP Service ready\r\n").as_deref(),
            Some("SMTP")
        );
        assert_eq!(greeting_label(b"220 (vsFTPd 3.0.5)\r\n").as_deref(), Some("FTP"));
        assert_eq!(
            greeting_label(b"INFO {\"server_id\":\"x\"}\r\n").as_deref(),
            Some("NATS")
        );
        assert_eq!(greeting_label(b"hello"), None);
    }

    #[test]
    fn names_replies_to_http() {
        assert_eq!(
            reply_label(b"E\x00\x00\x00\x67SFATAL\x00VFATAL").as_deref(),
            Some("PostgreSQL")
        );
        assert_eq!(reply_label(b"-ERR unknown command 'GET'").as_deref(), Some("Redis"));
        assert_eq!(reply_label(b"\x15\x03\x01\x00\x02\x02\x46").as_deref(), Some("TLS"));
        assert_eq!(reply_label(b"???"), None);
    }

    #[test]
    fn reads_pages() {
        let page =
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html><head><TITLE>\n  Grafana &amp; friends </TITLE>";
        assert_eq!(parse_http(page), Some((200, Some("Grafana & friends".into()))));
        assert_eq!(parse_http(b"HTTP/1.1 404 Not Found\r\n\r\n{}"), Some((404, None)));
        let api = b"HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{}";
        assert_eq!(parse_http(api), Some((404, Some("JSON API".into()))));
        let nginx = b"HTTP/1.1 200 OK\r\nServer: nginx/1.27.0\r\n\r\nhello";
        assert_eq!(parse_http(nginx), Some((200, Some("nginx".into()))));
        let https = b"HTTP/1.1 400 Bad Request\r\n\r\nThe plain HTTP request was sent to HTTPS port";
        assert_eq!(parse_http(https), Some((400, Some("HTTPS".into()))));
        assert_eq!(parse_http(b"-ERR"), None);
    }

    #[test]
    fn knows_answers_to_hellos() {
        assert!(hello_answered("PostgreSQL", b"N"));
        assert!(!hello_answered("PostgreSQL", b"HTTP/1.1"));
        assert!(hello_answered("Redis", b"-NOAUTH Authentication required."));
        let stun = [
            0x01, 0x01, 0, 12, 0x21, 0x12, 0xa4, 0x42, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        ];
        assert!(hello_answered("STUN/TURN", &stun));
        assert!(!hello_answered("STUN/TURN", b"nope"));
    }

    #[test]
    fn finds_the_engine_host() {
        assert_eq!(engine_host(None), "127.0.0.1");
        assert_eq!(
            engine_host(Some("unix:///Users/me/.lima/orca/sock/docker.sock")),
            "127.0.0.1"
        );
        assert_eq!(engine_host(Some("tcp://10.0.0.5:2375")), "10.0.0.5");
        assert_eq!(engine_host(Some("ssh://me@build.example.com")), "build.example.com");
        assert_eq!(engine_host(Some("tcp://[fd00::1]:2376")), "fd00::1");
        assert_eq!(probe_ip("127.0.0.1", Some("0.0.0.0")), "127.0.0.1");
        assert_eq!(probe_ip("127.0.0.1", Some("127.0.0.2")), "127.0.0.2");
        assert_eq!(probe_ip("10.0.0.5", Some("127.0.0.1")), "10.0.0.5");
    }

    #[tokio::test]
    async fn asks_a_real_server() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await;
            let _ = s
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<title>Mailpit</title>")
                .await;
        });
        let mapping = PortMapping {
            host_ip: None,
            host_port: port,
            container_port: 8025,
            protocol: "tcp".into(),
        };
        let udp = PortMapping {
            host_ip: None,
            host_port: port,
            container_port: 3478,
            protocol: "udp".into(),
        };
        let got = probe(None, &[mapping.clone(), mapping, udp]).await;
        assert_eq!(got.len(), 2);
        assert_eq!(
            (got[0].kind.clone(), got[0].label.as_deref(), got[0].status),
            (PortKind::Web, Some("Mailpit"), Some(200))
        );
        assert_eq!(got[1].kind, PortKind::NotChecked);
    }
}
