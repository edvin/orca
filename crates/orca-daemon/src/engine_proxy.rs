//! A Docker API proxy that rewrites host paths in requests, so a `docker`
//! CLI whose files live somewhere other than the engine's can use it: on
//! Windows, `docker.exe` sends `C:\code\app` and Orca's WSL engine needs
//! `/mnt/c/code/app`. Docker Desktop has the same kind of proxy.
//!
//! Only bind-mount sources are rewritten (`HostConfig.Binds`,
//! `HostConfig.Mounts` of type bind, and a local volume's bind `device`):
//! those are the host paths the API carries. Everything else passes through
//! byte for byte, including streamed bodies (`docker build`, `docker cp`),
//! and connections that switch to a raw stream (`attach`, `exec`), which the
//! proxy splices from then on.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

/// A host path as the engine sees it; `None` leaves it as it is.
pub type Rewrite = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Largest request head or JSON body the proxy reads whole.
const MAX_HEAD: usize = 64 * 1024;
const MAX_JSON: usize = 16 * 1024 * 1024;

/// Proxy one client connection to `upstream` until either side closes.
///
/// When the engine closes (a container's attached stream ended), the whole
/// client connection is closed: a Windows named pipe can't be half-closed,
/// and `docker.exe` only sees the end of an `attach` when the pipe closes.
/// When the client ends its requests (stdin's end, after `CloseWrite`), the
/// engine gets a half-close and its responses keep coming until it's done;
/// a client that went away (an error) ends everything.
pub async fn serve<C, U>(client: C, upstream: U, rewrite: Rewrite) -> std::io::Result<()>
where
    C: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    U: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (cr, mut cw) = tokio::io::split(client);
    let (mut ur, uw) = tokio::io::split(upstream);
    let responses = async move {
        let _ = tokio::io::copy(&mut ur, &mut cw).await;
        let _ = cw.shutdown().await;
        // Dropping the halves here (with the request side, below) closes
        // the client connection.
    };
    let requests = forward_requests(BufReader::new(cr), uw, rewrite);
    tokio::pin!(responses, requests);
    tokio::select! {
        _ = &mut responses => Ok(()),
        r = &mut requests => match r {
            Ok(()) => {
                responses.await;
                Ok(())
            }
            Err(e) => Err(e),
        },
    }
}

/// Forward requests until the client stops sending, then half-close the
/// engine's side.
async fn forward_requests<R, W>(mut cr: BufReader<R>, mut uw: W, rewrite: Rewrite) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let r = forward(&mut cr, &mut uw, &rewrite).await;
    let _ = uw.shutdown().await;
    r
}

async fn forward<R, W>(cr: &mut BufReader<R>, uw: &mut W, rewrite: &Rewrite) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    loop {
        let Some(head) = read_head(cr).await? else {
            return Ok(()); // the client closed between requests
        };
        let req = Head::parse(&head)?;
        if req.chunked && req.rewritable() {
            // A create request sent chunked (some SDKs do): read it whole to
            // rewrite it, and send it on with a length.
            let body = read_chunked(cr).await?;
            let new = rewrite_body(&req.path, &body, rewrite).unwrap_or(body);
            uw.write_all(&with_length(&without_chunked(&head), new.len())).await?;
            uw.write_all(&new).await?;
        } else if req.chunked {
            uw.write_all(&head).await?;
            copy_chunked(cr, uw).await?;
        } else if req.length > 0 {
            if req.rewritable() {
                let mut body = vec![0u8; req.length];
                cr.read_exact(&mut body).await?;
                match rewrite_body(&req.path, &body, rewrite) {
                    Some(new) => {
                        uw.write_all(&with_length(&head, new.len())).await?;
                        uw.write_all(&new).await?;
                    }
                    None => {
                        uw.write_all(&head).await?;
                        uw.write_all(&body).await?;
                    }
                }
            } else {
                uw.write_all(&head).await?;
                let mut body = (&mut *cr).take(req.length as u64);
                tokio::io::copy(&mut body, uw).await?;
            }
        } else {
            uw.write_all(&head).await?;
        }
        uw.flush().await?;
        if req.upgrade {
            // attach / exec: a raw stream both ways from here on.
            tokio::io::copy(cr, uw).await?;
            return Ok(());
        }
    }
}

/// A request head, through the blank line; `None` at a clean end of stream.
async fn read_head<R: AsyncRead + Unpin>(r: &mut BufReader<R>) -> std::io::Result<Option<Vec<u8>>> {
    let mut head = Vec::new();
    loop {
        // Never more than MAX_HEAD in all, even on a line with no end.
        let room = (MAX_HEAD + 1).saturating_sub(head.len()) as u64;
        let n = (&mut *r).take(room).read_until(b'\n', &mut head).await?;
        if n == 0 {
            return if head.is_empty() {
                Ok(None)
            } else {
                Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "request cut short"))
            };
        }
        if head.ends_with(b"\r\n\r\n") || head == b"\r\n" {
            if head == b"\r\n" {
                head.clear();
                continue; // a stray blank line between requests
            }
            return Ok(Some(head));
        }
        if head.len() > MAX_HEAD {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "request head too large"));
        }
    }
}

/// What the proxy needs to know about a request.
#[derive(Debug, PartialEq)]
struct Head {
    method: String,
    path: String,
    length: usize,
    chunked: bool,
    upgrade: bool,
}

impl Head {
    fn parse(head: &[u8]) -> std::io::Result<Self> {
        let text = String::from_utf8_lossy(head);
        let mut lines = text.split("\r\n");
        let first = lines.next().unwrap_or_default();
        let mut parts = first.split(' ');
        let (method, path) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
        if method.is_empty() || path.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not an HTTP request"));
        }
        let mut h = Head {
            method: method.to_string(),
            path: path.to_string(),
            length: 0,
            chunked: false,
            upgrade: false,
        };
        for line in lines {
            let Some((k, v)) = line.split_once(':') else { continue };
            let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_ascii_lowercase());
            match k.as_str() {
                "content-length" => {
                    h.length = v
                        .parse()
                        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad Content-Length"))?
                }
                "transfer-encoding" => h.chunked = v.contains("chunked"),
                "upgrade" => h.upgrade = true,
                "connection" => h.upgrade |= v.contains("upgrade"),
                _ => {}
            }
        }
        Ok(h)
    }

    /// A request whose JSON body can carry host paths (and is small
    /// enough to read whole).
    fn rewritable(&self) -> bool {
        let route = self.path.split('?').next().unwrap_or_default();
        self.method == "POST"
            && self.length <= MAX_JSON
            && (route.ends_with("/containers/create") || route.ends_with("/volumes/create"))
    }
}

/// The head with its Content-Length set to `n`.
fn with_length(head: &[u8], n: usize) -> Vec<u8> {
    let text = String::from_utf8_lossy(head);
    let mut out = String::with_capacity(text.len() + 8);
    for line in text.split_inclusive("\r\n") {
        if line
            .split_once(':')
            .is_some_and(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
        {
            out.push_str(&format!("Content-Length: {n}\r\n"));
        } else {
            out.push_str(line);
        }
    }
    out.into_bytes()
}

/// The head without its Transfer-Encoding, with a Content-Length to set.
fn without_chunked(head: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(head);
    let mut out = String::with_capacity(text.len() + 20);
    for line in text.split_inclusive("\r\n") {
        if line
            .split_once(':')
            .is_some_and(|(k, _)| k.trim().eq_ignore_ascii_case("transfer-encoding"))
        {
            continue;
        }
        if line == "\r\n" {
            out.push_str("Content-Length: 0\r\n");
        }
        out.push_str(line);
    }
    out.into_bytes()
}

/// A chunked body, read whole (up to MAX_JSON).
async fn read_chunked<R: AsyncRead + Unpin>(r: &mut BufReader<R>) -> std::io::Result<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let mut line = Vec::new();
        (&mut *r).take(1024).read_until(b'\n', &mut line).await?;
        let size_text = String::from_utf8_lossy(&line);
        let size = usize::from_str_radix(size_text.trim().split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad chunk size"))?;
        if size == 0 {
            loop {
                let mut t = Vec::new();
                (&mut *r).take(MAX_HEAD as u64).read_until(b'\n', &mut t).await?;
                if t == b"\r\n" || t.is_empty() {
                    return Ok(body);
                }
            }
        }
        if body.len() + size > MAX_JSON {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "request body too large"));
        }
        let start = body.len();
        body.resize(start + size, 0);
        r.read_exact(&mut body[start..]).await?;
        let mut crlf = [0u8; 2];
        r.read_exact(&mut crlf).await?;
    }
}

/// Pass a chunked body through as it is, stopping after its last chunk.
async fn copy_chunked<R, W>(r: &mut BufReader<R>, w: &mut W) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    loop {
        let mut line = Vec::new();
        r.read_until(b'\n', &mut line).await?;
        if line.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "chunked body cut short"));
        }
        w.write_all(&line).await?;
        let size_text = String::from_utf8_lossy(&line);
        let size = usize::from_str_radix(size_text.trim().split(';').next().unwrap_or("0").trim(), 16)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad chunk size"))?;
        if size == 0 {
            // Trailers, then the blank line that ends the body.
            loop {
                let mut t = Vec::new();
                r.read_until(b'\n', &mut t).await?;
                w.write_all(&t).await?;
                if t == b"\r\n" || t.is_empty() {
                    return Ok(());
                }
            }
        }
        let mut chunk = (&mut *r).take(size as u64 + 2); // data and its CRLF
        tokio::io::copy(&mut chunk, w).await?;
    }
}

/// The body with its host paths rewritten, or `None` when nothing changed.
fn rewrite_body(path: &str, body: &[u8], rewrite: &Rewrite) -> Option<Vec<u8>> {
    let mut v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let mut changed = false;
    let route = path.split('?').next().unwrap_or_default();
    if route.ends_with("/containers/create") {
        if let Some(binds) = v.pointer_mut("/HostConfig/Binds").and_then(|b| b.as_array_mut()) {
            for b in binds.iter_mut() {
                if let Some(s) = b.as_str()
                    && let Some(new) = rewrite_bind(s, rewrite)
                {
                    *b = serde_json::Value::String(new);
                    changed = true;
                }
            }
        }
        if let Some(mounts) = v.pointer_mut("/HostConfig/Mounts").and_then(|m| m.as_array_mut()) {
            for m in mounts.iter_mut() {
                if m["Type"].as_str() == Some("bind")
                    && let Some(src) = m["Source"].as_str()
                    && let Some(new) = rewrite(src)
                {
                    m["Source"] = serde_json::Value::String(new);
                    changed = true;
                }
            }
        }
    } else if route.ends_with("/volumes/create")
        && v.pointer("/DriverOpts/o").and_then(|o| o.as_str()).is_some_and(|o| o.contains("bind"))
        && let Some(dev) = v.pointer("/DriverOpts/device").and_then(|d| d.as_str())
        && let Some(new) = rewrite(dev)
    {
        v["DriverOpts"]["device"] = serde_json::Value::String(new);
        changed = true;
    }
    changed.then(|| serde_json::to_vec(&v).ok()).flatten()
}

/// A `src:dst[:opts]` bind with its source rewritten. The source can hold a
/// colon itself (`C:\code`), so it ends at the first `:/` after the drive.
fn rewrite_bind(bind: &str, rewrite: &Rewrite) -> Option<String> {
    let start = if bind.len() > 2 && bind.as_bytes()[1] == b':' { 2 } else { 0 };
    let i = bind[start..].find(":/").map(|i| i + start)?;
    let (src, rest) = (&bind[..i], &bind[i..]);
    rewrite(src).map(|s| format!("{s}{rest}"))
}

// --- Windows: docker.exe's way in --------------------------------------------

/// The named pipe `docker.exe` reaches Orca's engine through (its `orca`
/// context): `npipe:////./pipe/orca_docker`.
#[cfg(windows)]
pub const PIPE: &str = r"\\.\pipe\orca_docker";

/// A Windows path as Orca's WSL engine sees it; Linux paths are left alone,
/// except compose's old `/c/…` form (`COMPOSE_CONVERT_WINDOWS_PATHS`).
pub fn windows_rewrite() -> Rewrite {
    Arc::new(|p: &str| {
        let b = p.as_bytes();
        if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b'/' {
            return Some(format!("/mnt/{}{}", (b[1] as char).to_ascii_lowercase(), &p[2..]));
        }
        if p.starts_with('/') {
            None
        } else {
            orca_backend_common::wsl::engine_path(p)
        }
    })
}

/// The TLS client setup with the daemon's certificate, read once. The
/// certificates are made with the engine (never here: making new ones would
/// no longer match the engine's).
#[cfg(windows)]
fn tls_config() -> std::io::Result<Arc<rustls::ClientConfig>> {
    static CONFIG: std::sync::OnceLock<Arc<rustls::ClientConfig>> = std::sync::OnceLock::new();
    if let Some(c) = CONFIG.get() {
        return Ok(c.clone());
    }
    use std::io::{Error, ErrorKind};
    let certs = orca_backend_common::wsl::Certs {
        dir: orca_backend_common::wsl::certs_dir(),
    };
    let read_certs = |p: std::path::PathBuf| -> std::io::Result<Vec<rustls::pki_types::CertificateDer<'static>>> {
        let mut r = std::io::BufReader::new(std::fs::File::open(p)?);
        rustls_pemfile::certs(&mut r).collect()
    };
    let mut roots = rustls::RootCertStore::empty();
    for c in read_certs(certs.ca())? {
        roots.add(c).map_err(|e| Error::new(ErrorKind::InvalidData, e))?;
    }
    let key = {
        let mut r = std::io::BufReader::new(std::fs::File::open(certs.key())?);
        rustls_pemfile::private_key(&mut r)?.ok_or_else(|| Error::new(ErrorKind::InvalidData, "no client key"))?
    };
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_client_auth_cert(read_certs(certs.cert())?, key)
        .map_err(|e| Error::new(ErrorKind::InvalidData, e))?;
    Ok(CONFIG.get_or_init(|| Arc::new(config)).clone())
}

/// A TLS connection to Orca's engine with the daemon's client certificate.
#[cfg(windows)]
pub async fn connect_engine() -> std::io::Result<Engine> {
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", orca_backend_common::wsl::PORT)).await?;
    let name = rustls::pki_types::ServerName::try_from("localhost").expect("valid name");
    let tls = tokio_rustls::TlsConnector::from(tls_config()?).connect(name, tcp).await?;
    Ok(Engine { tls, closing: false })
}

/// The connection to Orca's engine. Its input ends as with docker's own
/// CLI over TLS: a close_notify, with the TCP connection left open. WSL's
/// forwarding of 127.0.0.1 closes the whole connection on a TCP half-close,
/// so an attached stream (`docker run`) ended before its output came.
#[cfg(windows)]
pub struct Engine {
    tls: tokio_rustls::client::TlsStream<tokio::net::TcpStream>,
    closing: bool,
}

#[cfg(windows)]
impl AsyncRead for Engine {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.tls).poll_read(cx, buf)
    }
}

#[cfg(windows)]
impl AsyncWrite for Engine {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.tls).poll_write(cx, buf)
    }

    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.tls).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if !self.closing {
            self.closing = true;
            self.tls.get_mut().1.send_close_notify();
        }
        std::pin::Pin::new(&mut self.tls).poll_flush(cx)
    }
}

/// What a client gets when Orca's engine isn't answering: a reply it shows.
#[cfg(windows)]
fn engine_down() -> Vec<u8> {
    let body = r#"{"message":"Orca's engine isn't running. Open Orca, or repair the engine on System Health."}"#;
    format!(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// The pipe stays a message pipe, which is what tells `docker.exe` it can
/// send an empty message for stdin's end, but this end reads it as bytes.
/// Read as messages, one longer than mio's 4 KB read buffer comes back as
/// an empty read with the 4 KB lost (`ERROR_MORE_DATA`): BuildKit's
/// streams ended at their first large frame, and large uploads lost data.
#[cfg(windows)]
fn byte_reads(
    pipe: tokio::net::windows::named_pipe::NamedPipeServer,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Pipes::{PIPE_READMODE_BYTE, SetNamedPipeHandleState};
    let mode = PIPE_READMODE_BYTE;
    let ok = unsafe { SetNamedPipeHandleState(pipe.as_raw_handle(), &mode, std::ptr::null(), std::ptr::null()) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(pipe)
}

/// Serve [`PIPE`] for as long as the daemon runs. The pipe has Windows'
/// default security: other users can't write to it, so only this user (and
/// administrators) can send requests; remote clients are refused. Message
/// mode, as Docker's own pipe, so `docker.exe` can signal the end of stdin
/// (`CloseWrite` sends an empty message, read here as end of input).
#[cfg(windows)]
pub async fn serve_pipe() {
    use tokio::net::windows::named_pipe::{PipeMode, ServerOptions};
    let options = |first: bool| {
        let mut o = ServerOptions::new();
        o.first_pipe_instance(first)
            .reject_remote_clients(true)
            .pipe_mode(PipeMode::Message);
        o
    };
    let mut server = loop {
        match options(true).create(PIPE).and_then(byte_reads) {
            Ok(s) => break s,
            Err(e) => {
                tracing::warn!("Could not open {PIPE}: {e}");
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            }
        }
    };
    loop {
        if let Err(e) = server.connect().await {
            tracing::debug!("{PIPE}: {e}");
        }
        // The next instance before handing this one off, so the name never
        // goes away (and can't be taken in between).
        let next = match options(false).create(PIPE).and_then(byte_reads) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("Could not open another {PIPE}: {e}");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
        };
        let client = std::mem::replace(&mut server, next);
        tokio::spawn(async move {
            match connect_engine().await {
                Ok(up) => {
                    let _ = serve(client, up, windows_rewrite()).await;
                }
                Err(e) => {
                    tracing::debug!("{PIPE}: Orca's engine isn't answering: {e}");
                    let mut client = client;
                    let _ = client.write_all(&engine_down()).await;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows() -> Rewrite {
        windows_rewrite()
    }

    /// The proxy between a real `docker` CLI and engine:
    /// `ORCA_PROXY_LISTEN=/tmp/p.sock ORCA_PROXY_UPSTREAM=/…/docker.sock`,
    /// rewriting `/fake/…` to `/tmp/…`.
    #[cfg(unix)]
    #[tokio::test]
    #[ignore]
    async fn manual_unix_proxy() {
        let listen = std::env::var("ORCA_PROXY_LISTEN").unwrap();
        let upstream = std::env::var("ORCA_PROXY_UPSTREAM").unwrap();
        let _ = std::fs::remove_file(&listen);
        let l = tokio::net::UnixListener::bind(&listen).unwrap();
        let rewrite: Rewrite = Arc::new(|p: &str| p.strip_prefix("/fake/").map(|r| format!("/tmp/{r}")));
        loop {
            let (c, _) = l.accept().await.unwrap();
            let up = tokio::net::UnixStream::connect(&upstream).await.unwrap();
            tokio::spawn(serve(c, up, rewrite.clone()));
        }
    }

    #[test]
    fn binds_and_mounts_get_engine_paths() {
        let body = serde_json::json!({
            "Image": "nginx",
            "HostConfig": {
                "Binds": [r"C:\code\app:/app", r"C:\data:/data:ro", "named:/x", "/etc/hosts:/h:ro"],
                "Mounts": [
                    {"Type": "bind", "Source": r"\\wsl.localhost\Ubuntu\home\me\src", "Target": "/src"},
                    {"Type": "volume", "Source": "db", "Target": "/db"}
                ]
            }
        });
        let out = rewrite_body("/v1.47/containers/create?name=x", &serde_json::to_vec(&body).unwrap(), &windows()).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(
            v["HostConfig"]["Binds"],
            serde_json::json!(["/mnt/c/code/app:/app", "/mnt/c/data:/data:ro", "named:/x", "/etc/hosts:/h:ro"])
        );
        assert_eq!(
            v["HostConfig"]["Mounts"][0]["Source"],
            "/mnt/wsl/orca/distros/Ubuntu/home/me/src"
        );
        assert_eq!(v["HostConfig"]["Mounts"][1]["Source"], "db");
    }

    #[test]
    fn bind_volumes_get_engine_paths() {
        let body = serde_json::json!({"Name": "src", "DriverOpts": {"type": "none", "o": "bind", "device": r"C:\code"}});
        let out = rewrite_body("/volumes/create", &serde_json::to_vec(&body).unwrap(), &windows()).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["DriverOpts"]["device"], "/mnt/c/code");
        let plain = serde_json::json!({"Name": "x"});
        assert!(rewrite_body("/volumes/create", &serde_json::to_vec(&plain).unwrap(), &windows()).is_none());
    }

    #[test]
    fn composes_old_drive_paths_get_engine_paths() {
        let r = windows();
        assert_eq!(r("/c/Users/me/app").as_deref(), Some("/mnt/c/Users/me/app"));
        assert_eq!(r("/home/me").as_deref(), None);
        assert_eq!(r(r"C:\x").as_deref(), Some("/mnt/c/x"));
    }

    #[tokio::test]
    async fn chunked_creates_are_rewritten_too() {
        let (client, proxy_client) = tokio::io::duplex(64 * 1024);
        let (proxy_up, upstream) = tokio::io::duplex(64 * 1024);
        tokio::spawn(serve(proxy_client, proxy_up, windows()));
        let (_cr, mut cw) = tokio::io::split(client);
        let (mut ur, _uw) = tokio::io::split(upstream);
        let body = br#"{"HostConfig":{"Binds":["C:\\x:/x"]}}"#;
        let mut req = b"POST /v1.47/containers/create HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        req.extend_from_slice(format!("{:x}\r\n", 10).as_bytes());
        req.extend_from_slice(&body[..10]);
        req.extend_from_slice(format!("\r\n{:x}\r\n", body.len() - 10).as_bytes());
        req.extend_from_slice(&body[10..]);
        req.extend_from_slice(b"\r\n0\r\n\r\n");
        cw.write_all(&req).await.unwrap();
        cw.shutdown().await.unwrap();
        let mut got = Vec::new();
        ur.read_to_end(&mut got).await.unwrap();
        let got = String::from_utf8(got).unwrap();
        assert!(!got.to_ascii_lowercase().contains("transfer-encoding"), "{got}");
        assert!(got.contains("Content-Length: 40\r\n\r\n{\"HostConfig\":{\"Binds\":[\"/mnt/c/x:/x\"]}}"), "{got}");
    }

    #[tokio::test]
    async fn the_client_connection_closes_when_the_engine_does() {
        // An attached stream: the engine ends it; the client must see the end
        // although it never stopped sending (a named pipe can't half-close).
        let (client, proxy_client) = tokio::io::duplex(64 * 1024);
        let (proxy_up, upstream) = tokio::io::duplex(64 * 1024);
        let proxy = tokio::spawn(serve(proxy_client, proxy_up, windows()));
        let (mut cr, mut cw) = tokio::io::split(client);
        cw.write_all(b"POST /containers/x/attach?stream=1 HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
            .await
            .unwrap();
        let (mut ur, mut uw) = tokio::io::split(upstream);
        let mut head = vec![0u8; 10];
        ur.read_exact(&mut head).await.unwrap();
        uw.write_all(b"HTTP/1.1 101 UPGRADED\r\n\r\nbye").await.unwrap();
        uw.shutdown().await.unwrap();
        let mut back = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(5), cr.read_to_end(&mut back))
            .await
            .expect("the client side closed")
            .unwrap();
        assert!(back.ends_with(b"bye"));
        tokio::time::timeout(std::time::Duration::from_secs(5), proxy).await.expect("proxy done").unwrap().unwrap();
    }

    #[test]
    fn reads_request_heads() {
        let h = Head::parse(
            b"POST /v1.47/containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: 12\r\n\r\n",
        )
        .unwrap();
        assert!(h.rewritable() && !h.upgrade && h.length == 12);
        assert!(Head::parse(b"POST / HTTP/1.1\r\nContent-Length: x\r\n\r\n").is_err());
        let a = Head::parse(
            b"POST /v1.47/containers/x/attach?stream=1 HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
        )
        .unwrap();
        assert!(a.upgrade && !a.rewritable());
        let b = Head::parse(b"POST /build HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
        assert!(b.chunked);
        assert_eq!(
            String::from_utf8(with_length(b"POST / HTTP/1.1\r\ncontent-length: 3\r\n\r\n", 10)).unwrap(),
            "POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\n"
        );
    }

    #[tokio::test]
    async fn requests_pass_through_and_get_rewritten() {
        let (client, proxy_client) = tokio::io::duplex(64 * 1024);
        let (proxy_up, upstream) = tokio::io::duplex(64 * 1024);
        tokio::spawn(serve(proxy_client, proxy_up, windows()));
        let (mut cr, mut cw) = tokio::io::split(client);
        let (mut ur, mut uw) = tokio::io::split(upstream);

        let body = br#"{"HostConfig":{"Binds":["C:\\x:/x"]}}"#;
        let mut req = format!(
            "POST /containers/create HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        req.extend_from_slice(body);
        req.extend_from_slice(b"POST /build HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n");
        req.extend_from_slice(b"GET /_ping HTTP/1.1\r\n\r\n");
        cw.write_all(&req).await.unwrap();
        // A split half closes its side with shutdown, not by being dropped.
        cw.shutdown().await.unwrap();

        let mut got = Vec::new();
        ur.read_to_end(&mut got).await.unwrap();
        let got = String::from_utf8(got).unwrap();
        assert!(got.contains(r#"{"HostConfig":{"Binds":["/mnt/c/x:/x"]}}"#), "{got}");
        assert!(got.contains("Content-Length: 40\r\n"), "{got}");
        assert!(got.contains("3\r\nabc\r\n0\r\n\r\nGET /_ping HTTP/1.1\r\n\r\n"), "{got}");

        uw.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        uw.shutdown().await.unwrap();
        let mut back = Vec::new();
        cr.read_to_end(&mut back).await.unwrap();
        assert_eq!(back, b"HTTP/1.1 200 OK\r\n\r\n");
    }
}
