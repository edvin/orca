//! Bringing what is in Docker Desktop over to Orca's engine, once: images,
//! named volumes (with their labels, so compose still owns them), the
//! networks projects join from outside, and the compose projects, recreated
//! from their own files. Docker Desktop's images and volumes are only read;
//! the containers that use what moves are stopped first, so databases are
//! copied at rest.
//!
//! Not moving is fine too: Orca's engine starts empty, projects are created
//! again on their next start, images pulled again, and volumes start empty.
//! Docker Desktop keeps everything either way.

use orca_backend_common::wsl::OnEngine;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use bollard::Docker;
use bollard::container::{
    Config, CreateContainerOptions, DownloadFromContainerOptions, ListContainersOptions, RemoveContainerOptions,
    StopContainerOptions, UploadToContainerOptions,
};
use bollard::image::{CreateImageOptions, ImportImageOptions, ListImagesOptions};
use bollard::models::{HostConfig, Mount, MountTypeEnum, MountVolumeOptions};
use bollard::network::{CreateNetworkOptions, ListNetworksOptions};
use bollard::volume::{CreateVolumeOptions, ListVolumesOptions};
use futures::StreamExt;
use orca_core::config::DockerDesktopMove;
use serde::{Deserialize, Serialize};

use crate::api::ApiError;
use crate::dev::jobs::JobHandle;
use crate::engine;
use crate::state::AppState;

/// Label on the volumes a move made, to tell a half-copied one (made again)
/// from one that was in Orca's engine already (left alone).
const MOVED_LABEL: &str = "orca.moved-from";
/// Where the helper containers mount a volume to copy it.
const MOUNT: &str = "/orca-move";
/// Pulled when an engine has no image at all to make a helper container from.
const HELPER_IMAGE: &str = "busybox:stable";

static MOVING: AtomicBool = AtomicBool::new(false);

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/docker-desktop", get(status))
        .route("/docker-desktop/plan", get(plan_route))
        .route("/docker-desktop/start", post(start_desktop))
        .route("/docker-desktop/move", post(move_route))
        .route("/docker-desktop/leave", post(leave))
        .route("/docker-desktop/quit", post(quit))
}

// --- engines -------------------------------------------------------------------

/// Where things come from: Docker Desktop, or (Windows) the Docker an
/// earlier Orca installed into the user's own default WSL distro.
#[derive(Debug, Clone, Copy, PartialEq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum From {
    #[default]
    Desktop,
    Earlier,
}

#[derive(Debug, Default, Deserialize)]
struct FromQuery {
    #[serde(default)]
    from: From,
}

/// The engine things come from.
pub struct Source {
    pub endpoint: engine::Endpoint,
    /// How the engine is named in messages: "Docker Desktop", "Docker in Ubuntu".
    pub name: String,
    pub docker: Docker,
}

/// The Docker an earlier Orca set up in the default WSL distro: plain TCP
/// on 2375.
const EARLIER: &str = "tcp://127.0.0.1:2375";

/// The engine for `from`, when it is running; a client that waits as long
/// as copying a large image or volume takes.
async fn source(from: From) -> Option<Source> {
    let long = 24 * 3600;
    match from {
        From::Desktop => {
            let stand_in = std::env::var("ORCA_DOCKER_DESKTOP_SOCKET").is_ok_and(|p| !p.is_empty());
            for e in engine::desktop_endpoints() {
                if let Some(d) = e.ping().await {
                    // `docker_engine` is also Docker Engine for Windows
                    // containers, and Docker Desktop's own in that mode.
                    if !stand_in && !(engine::is_desktop(&d).await && linux_engine(&d).await) {
                        continue;
                    }
                    let docker = e.client(long).ok()?;
                    return Some(Source {
                        endpoint: e,
                        name: "Docker Desktop".into(),
                        docker,
                    });
                }
            }
            None
        }
        From::Earlier => {
            if !cfg!(windows) {
                return None;
            }
            let e = engine::Endpoint::Tcp(EARLIER.into());
            let d = e.ping().await?;
            if engine::is_desktop(&d).await {
                return None;
            }
            let docker = e.client(long).ok()?;
            Some(Source {
                endpoint: e,
                name: format!("Docker in {}", default_distro().await.unwrap_or_else(|| "WSL".into())),
                docker,
            })
        }
    }
}

/// Whether an engine runs Linux containers.
async fn linux_engine(d: &Docker) -> bool {
    d.info().await.ok().and_then(|i| i.os_type).is_some_and(|o| o == "linux")
}

/// The user's default WSL distro, where an earlier Orca put Docker.
async fn default_distro() -> Option<String> {
    #[cfg(windows)]
    {
        let out = orca_backend_common::wsl::run(&["--list", "--verbose"]).await.ok()?;
        out.lines()
            .find(|l| l.trim_start().starts_with('*'))
            .and_then(|l| l.trim_start().trim_start_matches('*').split_whitespace().next())
            .map(str::to_string)
    }
    #[cfg(not(windows))]
    None
}

/// Whether Docker Desktop is installed (or something stands in for it).
fn desktop_installed() -> bool {
    if std::env::var("ORCA_DOCKER_DESKTOP_SOCKET").is_ok_and(|p| !p.is_empty()) {
        return true;
    }
    if cfg!(windows) {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        Path::new(&pf).join(r"Docker\Docker\Docker Desktop.exe").exists()
    } else if cfg!(target_os = "macos") {
        Path::new("/Applications/Docker.app").exists()
            || dirs::home_dir().is_some_and(|h| h.join("Applications/Docker.app").exists())
    } else {
        Path::new("/opt/docker-desktop").exists()
    }
}

/// Orca's engine, to move into.
pub struct Target {
    /// The address child CLIs get (`unix://…`, `tcp://…`).
    host: String,
    /// Orca's Lima VM (macOS), for its free space.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    vm: Option<String>,
    docker: Docker,
}

/// Orca's own engine, the one the daemon is connected to: its Lima VM on
/// macOS, its WSL distro on Windows, the system's engine on Linux.
async fn orca_engine(state: &AppState) -> Result<Target> {
    let rt = state.rt().await;
    let host = rt
        .host
        .clone()
        .context("Orca's engine isn't running. Set it up on System Health first.")?;
    let endpoint = engine::Endpoint::parse(&host).context("Orca's engine isn't running")?;
    if let engine::Endpoint::Unix(p) = &endpoint
        && engine::is_desktop_socket(p)
    {
        bail!("Orca is connected to Docker Desktop's engine");
    }
    let mut vm = None;
    if cfg!(target_os = "macos") {
        let engine::Endpoint::Unix(p) = &endpoint else {
            bail!("Orca's engine isn't running");
        };
        let v = lima_vm(p)
            .filter(|v| v == "orca" || v == "docker" || std::env::var("DOCKER_HOST").is_ok())
            .context(
                "Orca is using another engine (Settings → Engine). Switch to Orca's engine to bring things over.",
            )?;
        vm = Some(v);
    } else if cfg!(windows) && host != orca_backend_common::wsl::address() {
        bail!("Orca's engine isn't running. Set it up on System Health first.");
    }
    let endpoint = if cfg!(windows) { engine::Endpoint::OrcaWsl } else { endpoint };
    let docker = endpoint.client(24 * 3600)?;
    docker
        .ping()
        .await
        .context("Orca's engine isn't answering. Repair it on System Health.")?;
    Ok(Target { host, vm, docker })
}

/// The Lima VM a forwarded socket belongs to.
fn lima_vm(socket: &str) -> Option<String> {
    let vm = socket.split("/.lima/").nth(1)?.split('/').next()?;
    (!vm.is_empty()).then(|| vm.to_string())
}

/// What's left on a disk: `df -k` on Unix, from the second line's 4th column.
#[cfg(not(windows))]
async fn df_free(path: &Path) -> Option<u64> {
    let out = tokio::process::Command::new("df").arg("-k").arg(path).output().await.ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .nth(1)
        .and_then(|l| l.split_whitespace().nth(3).and_then(|k| k.parse::<u64>().ok()))
        .map(|k| k * 1024)
}

/// Free bytes for Orca's engine: the least of what its disk has left and
/// what the computer's disk has (a VM's or distro's disk grows into it).
async fn free_bytes(target: &Target) -> Option<u64> {
    let root = target
        .docker
        .info()
        .await
        .ok()
        .and_then(|i| i.docker_root_dir)
        .unwrap_or_else(|| "/".into());
    #[cfg(target_os = "macos")]
    {
        let vm = target.vm.as_deref()?;
        let out = tokio::process::Command::new("limactl")
            .env("PATH", crate::dev::ops::cli_path())
            .args(["shell", vm, "df", "-B1", "--output=avail", &root])
            .output()
            .await
            .ok()?;
        let in_vm: u64 = String::from_utf8_lossy(&out.stdout).lines().last()?.trim().parse().ok()?;
        let on_mac = df_free(&dirs::home_dir()?.join(".lima")).await;
        Some(on_mac.map_or(in_vm, |m| m.min(in_vm)))
    }
    #[cfg(windows)]
    {
        let _ = root;
        orca_backend_common::wsl::free_bytes().await
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        df_free(Path::new(&root)).await
    }
}

/// The record of what came over from `from`.
fn record(cfg: &mut orca_core::config::OrcaConfig, from: From) -> &mut DockerDesktopMove {
    match from {
        From::Desktop => cfg.docker_desktop.get_or_insert_with(DockerDesktopMove::default),
        From::Earlier => cfg.earlier_engine.get_or_insert_with(DockerDesktopMove::default),
    }
}

/// A compose project's folder as recorded in its labels, as a path Orca can
/// read. On Windows, a Linux path (`/home/me/app`, from `docker compose` run
/// in a distro) is looked for in each distro: `\\wsl.localhost\<distro>\home\me\app`.
async fn local_dir(dir: &str) -> String {
    #[cfg(windows)]
    if dir.starts_with('/') {
        for d in orca_backend_common::wsl::distros().await {
            if d.eq_ignore_ascii_case(orca_backend_common::wsl::DISTRO) || d.starts_with("docker-desktop") {
                continue;
            }
            let p = format!(r"\\wsl.localhost\{d}{}", dir.replace('/', "\\"));
            if Path::new(&p).exists() {
                return p;
            }
        }
    }
    dir.to_string()
}

// --- what is there -------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PlanImage {
    pub id: String,
    pub tags: Vec<String>,
    /// Tags Orca's engine doesn't have yet: only these are loaded, so a tag
    /// already there keeps pointing where it does.
    pub missing: Vec<String>,
    /// For an image with no tag, pulled pinned by its digest.
    pub digests: Vec<String>,
    pub size: u64,
    pub in_orca: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanVolume {
    pub name: String,
    pub size: Option<u64>,
    /// "copy" its contents, "define" it (a volume over a host folder, with
    /// nothing of its own to copy), or "skip" it.
    pub action: &'static str,
    pub note: Option<String>,
    pub project: Option<String>,
    pub driver: String,
    pub options: HashMap<String, String>,
    pub labels: HashMap<String, String>,
    /// Already in Orca's engine: "done" (copied before), "partial" (a copy
    /// that stopped half way: copied again), "theirs" (left as it is).
    pub in_orca: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanService {
    pub name: String,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanProject {
    pub name: String,
    pub dir: String,
    pub files: Vec<String>,
    pub env_files: Vec<String>,
    pub services: Vec<PlanService>,
    /// Why it can't be recreated (its folder or a compose file is gone).
    pub problem: Option<String>,
    pub in_orca: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    pub socket: String,
    pub version: Option<String>,
    pub images: Vec<PlanImage>,
    pub volumes: Vec<PlanVolume>,
    pub networks: Vec<String>,
    pub projects: Vec<PlanProject>,
    /// Containers outside compose, which aren't recreated (their images and
    /// volumes still come over).
    pub standalone: Vec<String>,
    /// Running containers in Docker Desktop that use what moves: stopped
    /// before copying.
    pub to_stop: Vec<String>,
    pub bytes_needed: u64,
    pub bytes_free: Option<u64>,
    pub anonymous_volumes: usize,
}

fn label<'a>(labels: &'a Option<HashMap<String, String>>, key: &str) -> Option<&'a str> {
    labels.as_ref()?.get(key).map(String::as_str)
}

fn container_name(c: &bollard::models::ContainerSummary) -> String {
    c.names
        .as_ref()
        .and_then(|n| n.first())
        .map(|n| n.trim_start_matches('/').to_string())
        .unwrap_or_else(|| c.id.clone().unwrap_or_default().chars().take(12).collect())
}

/// An anonymous volume: one Docker named itself, for a container's `VOLUME`.
fn anonymous(v: &bollard::models::Volume) -> bool {
    v.labels.contains_key("com.docker.volume.anonymous")
        || (v.name.len() == 64 && v.name.chars().all(|c| c.is_ascii_hexdigit()))
}

fn split_list(s: Option<&str>) -> Vec<String> {
    s.map(|s| {
        s.split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

async fn all_containers(docker: &Docker) -> Result<Vec<bollard::models::ContainerSummary>> {
    Ok(docker
        .list_containers(Some(ListContainersOptions::<String> {
            all: true,
            ..Default::default()
        }))
        .await?)
}

async fn volumes(docker: &Docker) -> Result<Vec<bollard::models::Volume>> {
    Ok(docker
        .list_volumes(None::<ListVolumesOptions<String>>)
        .await?
        .volumes
        .unwrap_or_default())
}

/// Every tag the engine has, and every image id.
async fn image_names(docker: &Docker) -> Result<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for i in docker
        .list_images(Some(ListImagesOptions::<String> {
            all: false,
            ..Default::default()
        }))
        .await?
    {
        names.extend(i.repo_tags.into_iter().filter(|t| t != "<none>:<none>"));
        names.extend(i.repo_digests);
        names.insert(i.id);
    }
    Ok(names)
}

/// What a move would bring over, and what it would leave.
pub async fn plan(state: &AppState, src: &Source, from: From) -> Result<Plan> {
    let target_engine = orca_engine(state).await?;
    let target = &target_engine.docker;
    let source = &src.docker;
    let version = source.version().await.ok().and_then(|v| v.version);
    let (done, partial): (BTreeSet<String>, BTreeSet<String>) = {
        let mut cfg = state.config.lock().await;
        let r = record(&mut cfg, from);
        (
            r.volumes_done.iter().cloned().collect(),
            r.volumes_partial.iter().cloned().collect(),
        )
    };

    // Images, one entry per image with all its tags.
    let in_orca_images = image_names(target).await?;
    let mut images = Vec::new();
    for i in source
        .list_images(Some(ListImagesOptions::<String> {
            all: false,
            ..Default::default()
        }))
        .await?
    {
        let tags: Vec<String> = i.repo_tags.into_iter().filter(|t| t != "<none>:<none>").collect();
        if tags.is_empty() && i.repo_digests.is_empty() {
            continue; // dangling: nothing names it
        }
        let missing: Vec<String> = tags.iter().filter(|t| !in_orca_images.contains(*t)).cloned().collect();
        let in_orca = if tags.is_empty() {
            i.repo_digests.iter().all(|d| in_orca_images.contains(d))
        } else {
            missing.is_empty()
        };
        images.push(PlanImage {
            id: i.id,
            tags,
            missing,
            digests: i.repo_digests,
            size: i.size.max(0) as u64,
            in_orca,
        });
    }
    images.sort_by(|a, b| a.tags.first().cmp(&b.tags.first()));

    // Volume sizes come from `docker system df`.
    let df = source.df().await.ok();
    let sizes: HashMap<String, i64> = df
        .as_ref()
        .and_then(|d| d.volumes.clone())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| Some((v.name, v.usage_data?.size)))
        .collect();
    let target_volumes: HashMap<String, bollard::models::Volume> =
        volumes(target).await?.into_iter().map(|v| (v.name.clone(), v)).collect();
    let mut vols = Vec::new();
    let mut anonymous_volumes = 0;
    for v in volumes(source).await? {
        if anonymous(&v) {
            anonymous_volumes += 1;
            continue;
        }
        let (action, note) = if v.driver != "local" {
            ("skip", Some(format!("Its driver, {}, isn't in Orca's engine", v.driver)))
        } else if !v.options.is_empty() {
            (
                "define",
                Some("Stores its files elsewhere (driver options): made with the same options, nothing to copy".into()),
            )
        } else {
            ("copy", None)
        };
        // Only a copy this move recorded as started and not finished is
        // "partial" (made again); anything else already there is left alone.
        let in_orca = target_volumes.get(&v.name).map(|_| {
            if done.contains(&v.name) {
                "done"
            } else if partial.contains(&v.name) {
                "partial"
            } else {
                "theirs"
            }
        });
        vols.push(PlanVolume {
            size: sizes.get(&v.name).filter(|s| **s >= 0).map(|s| *s as u64),
            action,
            note,
            project: v.labels.get("com.docker.compose.project").cloned(),
            driver: v.driver,
            options: v.options,
            labels: v.labels,
            in_orca,
            name: v.name,
        });
    }
    vols.sort_by(|a, b| a.name.cmp(&b.name));

    // Networks made outside compose, which projects join as `external`.
    let target_networks: BTreeSet<String> = target
        .list_networks(None::<ListNetworksOptions<String>>)
        .await?
        .into_iter()
        .filter_map(|n| n.name)
        .collect();
    let mut networks: Vec<String> = source
        .list_networks(None::<ListNetworksOptions<String>>)
        .await?
        .into_iter()
        .filter(|n| n.driver.as_deref() == Some("bridge"))
        .filter(|n| {
            !n.labels
                .as_ref()
                .is_some_and(|l| l.contains_key("com.docker.compose.network"))
        })
        .filter_map(|n| n.name)
        .filter(|n| !["bridge", "host", "none"].contains(&n.as_str()) && !target_networks.contains(n))
        .collect();
    networks.sort();

    // Compose projects, from their containers' labels.
    let containers = all_containers(source).await?;
    let target_projects: BTreeSet<String> = all_containers(target)
        .await?
        .iter()
        .filter_map(|c| label(&c.labels, "com.docker.compose.project").map(str::to_string))
        .collect();
    let mut projects: BTreeMap<String, PlanProject> = BTreeMap::new();
    let mut standalone = Vec::new();
    for c in &containers {
        let Some(project) = label(&c.labels, "com.docker.compose.project") else {
            if label(&c.labels, "orca.managed") != Some("true") {
                standalone.push(container_name(c));
            }
            continue;
        };
        if label(&c.labels, "com.docker.compose.oneoff").is_some_and(|v| v.eq_ignore_ascii_case("true")) {
            continue; // `compose run`: not a service
        }
        if !projects.contains_key(project) {
            let dir = local_dir(label(&c.labels, "com.docker.compose.project.working_dir").unwrap_or_default()).await;
            let mut files = Vec::new();
            for f in split_list(label(&c.labels, "com.docker.compose.project.config_files")) {
                files.push(local_dir(&f).await);
            }
            let mut env_files = Vec::new();
            for f in split_list(label(&c.labels, "com.docker.compose.project.environment_file")) {
                env_files.push(local_dir(&f).await);
            }
            let problem = if dir.is_empty() || !Path::new(&dir).is_dir() {
                Some(format!("Its folder {dir} is gone"))
            } else {
                files
                    .iter()
                    .chain(&env_files)
                    .find(|f| !Path::new(f).is_file())
                    .map(|f| format!("{f} is gone"))
            };
            projects.insert(project.to_string(), PlanProject {
                name: project.to_string(),
                in_orca: target_projects.contains(project),
                dir,
                files,
                env_files,
                services: Vec::new(),
                problem,
            });
        }
        let p = projects.get_mut(project).expect("just added");
        if let Some(service) = label(&c.labels, "com.docker.compose.service")
            && !p.services.iter().any(|s| s.name == service)
        {
            p.services.push(PlanService {
                name: service.to_string(),
                running: c.state.as_deref() == Some("running"),
            });
        }
    }
    let projects: Vec<PlanProject> = projects.into_values().collect();
    standalone.sort();

    let to_stop = to_stop(&containers, &projects, &vols, None);

    let image_bytes: u64 = images.iter().filter(|i| !i.in_orca).map(|i| i.size).sum();
    let layers = df.as_ref().and_then(|d| d.layers_size).unwrap_or(i64::MAX).max(0) as u64;
    let volume_bytes: u64 = vols
        .iter()
        .filter(|v| v.action == "copy" && !matches!(v.in_orca, Some("done" | "theirs")))
        .filter_map(|v| v.size)
        .sum();
    Ok(Plan {
        socket: src.endpoint.shown(),
        version,
        images,
        volumes: vols,
        networks,
        projects,
        standalone,
        to_stop,
        bytes_needed: image_bytes.min(layers) + volume_bytes,
        bytes_free: free_bytes(&target_engine).await,
        anonymous_volumes,
    })
}

/// Running containers that use a project or a volume that moves.
fn to_stop(
    containers: &[bollard::models::ContainerSummary],
    projects: &[PlanProject],
    vols: &[PlanVolume],
    skip: Option<&BTreeSet<String>>,
) -> Vec<String> {
    let moving: BTreeSet<&str> = projects
        .iter()
        .filter(|p| p.problem.is_none() && !p.in_orca && !skip.is_some_and(|s| s.contains(&p.name)))
        .map(|p| p.name.as_str())
        .collect();
    let copied: BTreeSet<&str> = vols
        .iter()
        .filter(|v| v.action == "copy")
        .map(|v| v.name.as_str())
        .collect();
    let mut out: Vec<String> = containers
        .iter()
        .filter(|c| c.state.as_deref() == Some("running"))
        .filter(|c| {
            label(&c.labels, "com.docker.compose.project").is_some_and(|p| moving.contains(p))
                || c.mounts.iter().flatten().any(|m| {
                    m.typ == Some(bollard::models::MountPointTypeEnum::VOLUME)
                        && m.name.as_deref().is_some_and(|n| copied.contains(n))
                })
        })
        .map(container_name)
        .collect();
    out.sort();
    out
}

// --- copying -------------------------------------------------------------------

/// Counts a tar stream's entries and file bytes as it goes by: a copy with
/// the same count on both sides arrived whole.
#[derive(Default, Debug, PartialEq)]
struct TarTally {
    header: Vec<u8>,
    skip: u64,
    /// An extended (PAX) header's records being read: they can carry the
    /// next entry's real size (8 GiB and up), with 0 in its own header.
    pax: Option<Vec<u8>>,
    pax_left: u64,
    next_size: Option<u64>,
    entries: u64,
    bytes: u64,
    ended: bool,
}

impl TarTally {
    fn feed(&mut self, mut data: &[u8]) {
        while !data.is_empty() && !self.ended {
            if self.skip > 0 {
                let n = self.skip.min(data.len() as u64) as usize;
                if let Some(pax) = self.pax.as_mut() {
                    let keep = self.pax_left.min(n as u64) as usize;
                    pax.extend_from_slice(&data[..keep]);
                    self.pax_left -= keep as u64;
                }
                self.skip -= n as u64;
                data = &data[n..];
                if self.skip == 0
                    && let Some(pax) = self.pax.take()
                {
                    self.next_size = pax_size(&pax);
                }
                continue;
            }
            let n = (512 - self.header.len()).min(data.len());
            self.header.extend_from_slice(&data[..n]);
            data = &data[n..];
            if self.header.len() < 512 {
                return;
            }
            let h = std::mem::take(&mut self.header);
            if h.iter().all(|b| *b == 0) {
                self.ended = true;
                return;
            }
            let header_size = tar_size(&h[124..136]);
            let kind = h[156];
            let size = match kind {
                b'x' | b'g' | b'L' | b'K' => header_size,
                _ => self.next_size.take().unwrap_or(header_size),
            };
            self.skip = size.div_ceil(512) * 512;
            match kind {
                // A PAX header for the next entry: read its records.
                b'x' if size > 0 && size <= 1 << 20 => {
                    self.pax = Some(Vec::with_capacity(size as usize));
                    self.pax_left = size;
                }
                // Long names and global headers describe what follows.
                b'x' | b'g' | b'L' | b'K' => {}
                b'0' | b'\0' | b'7' => {
                    self.entries += 1;
                    self.bytes += size;
                }
                _ => self.entries += 1,
            }
        }
    }
}

/// The `size` record of PAX extended header data (`"27 size=10737418240\n"`).
fn pax_size(data: &[u8]) -> Option<u64> {
    let text = String::from_utf8_lossy(data);
    text.lines()
        .filter_map(|l| l.split_once(' ').map(|(_, kv)| kv))
        .find_map(|kv| kv.strip_prefix("size=")?.trim().parse().ok())
}

/// A tar header's size field: octal, or base-256 for large files.
fn tar_size(field: &[u8]) -> u64 {
    if field[0] & 0x80 != 0 {
        return field[1..].iter().fold(u64::from(field[0] & 0x7f), |n, b| (n << 8) | u64::from(*b));
    }
    let s: String = field
        .iter()
        .take_while(|b| **b != 0)
        .map(|b| *b as char)
        .collect();
    u64::from_str_radix(s.trim(), 8).unwrap_or(0)
}

/// A stopped container from `image` with `volume` at [`MOUNT`], to read or
/// write the volume through the archive API. It never runs.
async fn helper(docker: &Docker, image: &str, volume: &str, read_only: bool) -> Result<String> {
    let name = format!("orca-move-{:08x}", rand::random::<u32>());
    let labels = HashMap::from([
        ("orca.managed".to_string(), "true".to_string()),
        ("orca.role".to_string(), "move-helper".to_string()),
    ]);
    let created = docker
        .create_container(
            Some(CreateContainerOptions {
                name: name.clone(),
                platform: None,
            }),
            Config {
                image: Some(image.to_string()),
                cmd: Some(vec!["true".to_string()]),
                labels: Some(labels),
                network_disabled: Some(true),
                host_config: Some(HostConfig {
                    mounts: Some(vec![Mount {
                        target: Some(MOUNT.to_string()),
                        source: Some(volume.to_string()),
                        typ: Some(MountTypeEnum::VOLUME),
                        read_only: Some(read_only),
                        volume_options: Some(MountVolumeOptions {
                            no_copy: Some(true),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }]),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .with_context(|| format!("could not make a helper container from {image}"))?;
    Ok(created.id)
}

async fn remove(docker: &Docker, id: &str) {
    let _ = docker
        .remove_container(
            id,
            Some(RemoveContainerOptions {
                force: true,
                v: true,
                ..Default::default()
            }),
        )
        .await;
}

/// An image the engine has to make helper containers from: a small one by
/// name if it has one, else its smallest, else `busybox` pulled.
async fn helper_image(docker: &Docker) -> Result<String> {
    let images = docker
        .list_images(Some(ListImagesOptions::<String> {
            all: false,
            ..Default::default()
        }))
        .await?;
    let mut tagged: Vec<(i64, String)> = images
        .iter()
        .flat_map(|i| {
            i.repo_tags
                .iter()
                .filter(|t| *t != "<none>:<none>")
                .map(move |t| (i.size, t.clone()))
        })
        .collect();
    tagged.sort();
    let small = |t: &str| {
        let repo = t.rsplit_once(':').map_or(t, |(r, _)| r);
        let base = repo.rsplit('/').next().unwrap_or(repo);
        base == "busybox" || base == "alpine"
    };
    if let Some((_, t)) = tagged.iter().find(|(_, t)| small(t)).or(tagged.first()) {
        return Ok(t.clone());
    }
    pull(docker, HELPER_IMAGE).await?;
    Ok(HELPER_IMAGE.to_string())
}

async fn pull(docker: &Docker, image: &str) -> Result<()> {
    let mut s = docker.create_image(
        Some(CreateImageOptions {
            from_image: image.to_string(),
            ..Default::default()
        }),
        None,
        None,
    );
    while let Some(r) = s.next().await {
        r.with_context(|| format!("could not pull {image}"))?;
    }
    Ok(())
}

/// Stream an image (all its tags) from one engine into the other.
async fn copy_image(source: &Docker, target: &Docker, image: &PlanImage) -> Result<&'static str> {
    if !image.tags.is_empty() {
        let names: Vec<&str> = image.missing.iter().map(String::as_str).collect();
        let failed: Arc<StdMutex<Option<String>>> = Arc::default();
        let f = failed.clone();
        let tar = source
            .export_images(&names)
            .map(move |r| match r {
                Ok(b) => Some(b),
                Err(e) => {
                    *f.lock().unwrap() = Some(e.to_string());
                    None
                }
            })
            .take_while(|b| std::future::ready(b.is_some()))
            .filter_map(std::future::ready);
        let mut load = target.import_image_stream(ImportImageOptions { quiet: true }, tar, None);
        let mut load_err = None;
        while let Some(r) = load.next().await {
            if let Err(e) = r {
                load_err = Some(e.to_string());
                break;
            }
        }
        drop(load);
        let err = failed.lock().unwrap().take().or(load_err);
        if err.is_none() && arrived(target, image).await {
            return Ok("copied");
        }
        // Docker Desktop can't always export an image (one platform of a
        // multi-platform image is missing, say): pull it again if it came
        // from a registry.
        let err = err.unwrap_or_else(|| "it didn't arrive".into());
        for tag in &image.missing {
            // The very same image, by its digest, not whatever the tag
            // points at today (a newer database could upgrade its data).
            let Some(digest) = digest_for(tag, &image.digests) else {
                bail!("{err}; it has no registry digest to pull it again by");
            };
            pull(target, &digest)
                .await
                .map_err(|e| anyhow::anyhow!("{err}; pulling it again failed too: {e:#}"))?;
            let (repo, t) = split_tag(tag);
            target
                .tag_image(&digest, Some(bollard::image::TagImageOptions { repo, tag: t }))
                .await
                .with_context(|| format!("could not tag {digest} as {tag}"))?;
        }
        return Ok("pulled again");
    }
    for name in &image.digests {
        pull(target, name).await?;
    }
    Ok("pulled again")
}

/// `repo` and `tag` of `repo:tag` (a registry port isn't a tag).
fn split_tag(tag: &str) -> (&str, &str) {
    match tag.rsplit_once(':') {
        Some((repo, t)) if !t.contains('/') => (repo, t),
        _ => (tag, "latest"),
    }
}

/// The `repo@sha256:…` among `digests` for `tag`'s repository.
fn digest_for(tag: &str, digests: &[String]) -> Option<String> {
    let (repo, _) = split_tag(tag);
    digests.iter().find(|d| d.split_once('@').is_some_and(|(r, _)| r == repo)).cloned()
}

async fn arrived(target: &Docker, image: &PlanImage) -> bool {
    let names = if image.tags.is_empty() { &image.digests } else { &image.tags };
    for n in names {
        if target.inspect_image(n).await.is_err() {
            return false;
        }
    }
    true
}

/// A volume's driver options for Orca's engine: Docker Desktop on Windows
/// sees `C:\` at `/run/desktop/mnt/host/c`, Orca's WSL engine at `/mnt/c`.
fn target_options(options: &HashMap<String, String>) -> HashMap<String, String> {
    let mut out = options.clone();
    if let Some(dev) = out.get_mut("device")
        && let Some(rest) = dev.strip_prefix("/run/desktop/mnt/host/")
    {
        *dev = format!("/mnt/{rest}");
    }
    out
}

/// A volume's archive from a helper container, tallied as it streams.
async fn read_tally(docker: &Docker, id: &str) -> Result<TarTally> {
    let mut tally = TarTally::default();
    let mut s = docker.download_from_container(id, Some(DownloadFromContainerOptions { path: MOUNT }));
    while let Some(chunk) = s.next().await {
        tally.feed(&chunk?);
    }
    Ok(tally)
}

/// Make `volume` in Orca's engine as it is in Docker Desktop, labels and all,
/// and copy its files over, ownership and modes kept. Returns the file count
/// and bytes, checked by reading the copy back.
async fn copy_volume(
    source: &Docker,
    target: &Docker,
    volume: &PlanVolume,
    images: (&str, &str),
) -> Result<(u64, u64)> {
    if volume.in_orca == Some("partial") {
        // Recorded as started by this move and never finished: made again.
        target
            .remove_volume(&volume.name, None)
            .await
            .context("could not remove the half-copied volume to copy it again (is it in use?)")?;
    }
    let mut labels = volume.labels.clone();
    labels.insert(MOVED_LABEL.into(), "docker-desktop".into());
    target
        .create_volume(CreateVolumeOptions {
            name: volume.name.clone(),
            driver: volume.driver.clone(),
            driver_opts: target_options(&volume.options),
            labels,
        })
        .await
        .context("could not make the volume")?;
    if volume.action == "define" {
        return Ok((0, 0));
    }

    let from = helper(source, images.0, &volume.name, true).await?;
    let to = match helper(target, images.1, &volume.name, false).await {
        Ok(id) => id,
        Err(e) => {
            remove(source, &from).await;
            return Err(e);
        }
    };
    let result = async {
        let tally = Arc::new(StdMutex::new(TarTally::default()));
        let failed: Arc<StdMutex<Option<String>>> = Arc::default();
        let (t, f) = (tally.clone(), failed.clone());
        let tar = source
            .download_from_container(&from, Some(DownloadFromContainerOptions { path: MOUNT }))
            .map(move |r| match r {
                Ok(b) => {
                    t.lock().unwrap().feed(&b);
                    Some(b)
                }
                Err(e) => {
                    *f.lock().unwrap() = Some(e.to_string());
                    None
                }
            })
            .take_while(|b| std::future::ready(b.is_some()))
            .filter_map(std::future::ready);
        target
            .upload_to_container_streaming(
                &to,
                Some(UploadToContainerOptions {
                    path: "/",
                    no_overwrite_dir_non_dir: "false",
                }),
                tar,
            )
            .await
            .context("Orca's engine could not write the files")?;
        if let Some(e) = failed.lock().unwrap().take() {
            bail!("reading it from Docker Desktop stopped: {e}");
        }
        let sent = std::mem::take(&mut *tally.lock().unwrap());
        if !sent.ended {
            bail!("the copy from Docker Desktop ended early");
        }
        let got = read_tally(target, &to).await.context("could not read the copy back")?;
        if (got.entries, got.bytes) != (sent.entries, sent.bytes) {
            bail!(
                "the copy differs: {} files, {} bytes sent; {} files, {} bytes arrived",
                sent.entries,
                sent.bytes,
                got.entries,
                got.bytes
            );
        }
        Ok((sent.entries, sent.bytes))
    }
    .await;
    remove(source, &from).await;
    remove(target, &to).await;
    result
}

// --- the move ------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(default)]
struct MoveRequest {
    from: From,
    images: bool,
    volumes: bool,
    projects: bool,
    /// Projects to leave in Docker Desktop.
    skip: Vec<String>,
    /// Point the `docker` command at Orca's engine afterwards.
    switch_cli: bool,
    quit_desktop: bool,
}

impl Default for MoveRequest {
    fn default() -> Self {
        Self {
            from: From::Desktop,
            images: true,
            volumes: true,
            projects: true,
            skip: Vec::new(),
            switch_cli: true,
            quit_desktop: false,
        }
    }
}

/// What came over, and what didn't, for the summary.
#[derive(Default, Serialize)]
struct Outcome {
    images: usize,
    images_pulled: usize,
    volumes: usize,
    networks: usize,
    projects: usize,
    /// What went wrong: these are still only in Docker Desktop.
    problems: Vec<String>,
    /// What a move doesn't recreate, and why.
    left: Vec<String>,
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Remove helper containers a move left behind (an engine that stopped
/// half way through a copy).
async fn clear_helpers(docker: &Docker) {
    let filters = HashMap::from([("label".to_string(), vec!["orca.role=move-helper".to_string()])]);
    if let Ok(list) = docker
        .list_containers(Some(ListContainersOptions::<String> {
            all: true,
            filters,
            ..Default::default()
        }))
        .await
    {
        for c in list {
            if let Some(id) = c.id {
                remove(docker, &id).await;
            }
        }
    }
}

fn gib(bytes: u64) -> String {
    let g = bytes as f64 / (1u64 << 30) as f64;
    if g >= 10.0 {
        format!("{g:.0} GB")
    } else if g >= 0.1 {
        format!("{g:.1} GB")
    } else {
        format!("{} MB", (bytes >> 20).max(1))
    }
}

/// Bring things over. A move that fails part way starts the containers it
/// stopped in the source again.
async fn run_move(state: Arc<AppState>, job: JobHandle, req: MoveRequest) -> Result<Outcome> {
    let mut stopped = Vec::new();
    let from = req.from;
    let result = move_things(state, job.clone(), req, &mut stopped).await;
    if result.is_err()
        && !stopped.is_empty()
        && let Some(src) = source(from).await
    {
        for name in &stopped {
            job.log(format!("Starting {name} again in {}", src.name)).await;
            let _ = src.docker.start_container::<String>(name, None).await;
        }
    }
    result
}

async fn move_things(
    state: Arc<AppState>,
    job: JobHandle,
    req: MoveRequest,
    stopped: &mut Vec<String>,
) -> Result<Outcome> {
    let mut out = Outcome::default();

    job.start("check").await;
    let src = source(req.from).await.with_context(|| match req.from {
        From::Desktop => "Docker Desktop isn't running. Start it, then bring things over.".to_string(),
        From::Earlier => format!("The earlier Docker on {EARLIER} isn't answering. Start it, then bring things over."),
    })?;
    let target_engine = orca_engine(&state).await?;
    let (source, target) = (&src.docker, &target_engine.docker);
    let from_name = src.name.clone();
    clear_helpers(source).await;
    clear_helpers(target).await;
    let plan = plan(&state, &src, req.from).await?;
    let skip: BTreeSet<String> = req.skip.iter().cloned().collect();
    let containers = all_containers(source).await?;
    // Volumes only projects left in the source use stay there with them
    // (and their containers keep running).
    let skipped_only = |v: &PlanVolume| {
        if v.project.as_ref().is_some_and(|p| skip.contains(p)) {
            return true;
        }
        let users: Vec<&bollard::models::ContainerSummary> = containers
            .iter()
            .filter(|c| {
                c.mounts.iter().flatten().any(|m| {
                    m.typ == Some(bollard::models::MountPointTypeEnum::VOLUME) && m.name.as_deref() == Some(&v.name)
                })
            })
            .collect();
        !users.is_empty()
            && users
                .iter()
                .all(|c| label(&c.labels, "com.docker.compose.project").is_some_and(|p| skip.contains(p)))
    };
    let images: Vec<&PlanImage> = if req.images {
        plan.images.iter().filter(|i| !i.in_orca).collect()
    } else {
        Vec::new()
    };
    let vols: Vec<&PlanVolume> = if req.volumes {
        plan.volumes
            .iter()
            .filter(|v| v.action != "skip" && !matches!(v.in_orca, Some("done" | "theirs")) && !skipped_only(v))
            .collect()
    } else {
        Vec::new()
    };
    for p in &plan.projects {
        if let Some(why) = &p.problem
            && req.projects
            && !skip.contains(&p.name)
        {
            out.left.push(format!("Project {}: {why}", p.name));
        }
    }
    out.left.extend(
        plan.standalone
            .iter()
            .map(|c| format!("Container {c}: not part of a compose project, so not recreated")),
    );
    // A project comes over only with its data: every named volume it uses
    // is copied now or in Orca already. Others stay (and keep running) in
    // the source, rather than starting on new, empty volumes.
    let will_have: BTreeSet<&str> = plan
        .volumes
        .iter()
        .filter(|v| matches!(v.in_orca, Some("done" | "theirs")) || vols.iter().any(|c| c.name == v.name))
        .map(|v| v.name.as_str())
        .collect();
    let named: BTreeSet<&str> = plan.volumes.iter().map(|v| v.name.as_str()).collect();
    let mut projects: Vec<&PlanProject> = Vec::new();
    if req.projects {
        for p in plan
            .projects
            .iter()
            .filter(|p| !skip.contains(&p.name) && !p.in_orca && p.problem.is_none())
        {
            let staying: Vec<&str> = volumes_of(&containers, &plan.volumes, &p.name)
                .into_iter()
                .map(String::as_str)
                .filter(|v| named.contains(v) && !will_have.contains(v))
                .collect();
            if staying.is_empty() {
                projects.push(p);
            } else {
                out.left.push(format!(
                    "Project {}: not recreated, as its volume {} isn't coming over",
                    p.name,
                    staying.join(", ")
                ));
            }
        }
    }
    let needed = images.iter().map(|i| i.size).sum::<u64>().min(plan.bytes_needed)
        + vols.iter().filter(|v| v.action == "copy").filter_map(|v| v.size).sum::<u64>();
    if let Some(free) = plan.bytes_free
        && needed > free.saturating_sub(2 << 30)
    {
        bail!(
            "Not enough space: this needs about {}, and Orca's engine has {} free (keeping 2 GB spare). \
             Free some space, or leave the images out (they can be pulled again).",
            gib(needed),
            gib(free)
        );
    }
    job.done(
        "check",
        Some(format!(
            "{} images, {} volumes, {} projects; about {}{}",
            images.len(),
            vols.len(),
            projects.len(),
            gib(needed),
            plan.bytes_free.map(|f| format!(" of {} free", gib(f))).unwrap_or_default()
        )),
    )
    .await;

    // Stop what uses the volumes, so they are copied at rest.
    job.start("stop").await;
    let moving_projects: Vec<PlanProject> = projects.iter().map(|p| (*p).clone()).collect();
    let copied: Vec<PlanVolume> = vols
        .iter()
        .filter(|v| v.action == "copy")
        .map(|v| (*v).clone())
        .collect();
    let stop = to_stop(&containers, &moving_projects, &copied, Some(&skip));
    for name in &stop {
        job.log(format!("Stopping {name} in {from_name}")).await;
        source
            .stop_container(name, Some(StopContainerOptions { t: 30 }))
            .await
            .with_context(|| format!("could not stop {name} in {from_name}"))?;
        stopped.push(name.clone());
    }
    if stop.is_empty() {
        job.skip("stop", "Nothing that moves is running").await;
    } else {
        job.done("stop", Some(format!("{} stopped", stop.len()))).await;
    }

    job.start("images").await;
    if images.is_empty() {
        job.skip("images", if req.images { "None to copy" } else { "Left out" })
            .await;
    } else {
        for (n, image) in images.iter().enumerate() {
            let name = image.tags.first().or(image.digests.first()).cloned().unwrap_or_default();
            job.log(format!("Image {}/{}: {name} ({})", n + 1, images.len(), gib(image.size)))
                .await;
            match copy_image(source, target, image).await {
                Ok("copied") => out.images += 1,
                Ok(_) => {
                    out.images_pulled += 1;
                    job.log(format!("  {name}: pulled again from its registry")).await;
                }
                Err(e) => {
                    job.log(format!("  {name}: not copied: {e:#}")).await;
                    out.problems.push(format!("Image {name}: {e:#}"));
                }
            }
        }
        job.done(
            "images",
            Some(format!(
                "{} copied{}",
                out.images,
                if out.images_pulled > 0 {
                    format!(", {} pulled again", out.images_pulled)
                } else {
                    String::new()
                }
            )),
        )
        .await;
    }

    job.start("volumes").await;
    let mut copied_ok = BTreeSet::new();
    if vols.is_empty() {
        job.skip("volumes", if req.volumes { "None to copy" } else { "Left out" })
            .await;
    } else {
        let helpers = (
            helper_image(source)
                .await
                .with_context(|| format!("no image in {from_name} to read volumes with"))?,
            helper_image(target).await.context("no image in Orca's engine to write volumes with")?,
        );
        for (n, v) in vols.iter().enumerate() {
            job.log(format!(
                "Volume {}/{}: {}{}",
                n + 1,
                vols.len(),
                v.name,
                v.size.map(|s| format!(" ({})", gib(s))).unwrap_or_default()
            ))
            .await;
            // Recorded before the volume is made: only a copy recorded as
            // started (and not finished) is ever made again by a later move.
            {
                let mut cfg = state.config.lock().await;
                let m = record(&mut cfg, req.from);
                if !m.volumes_partial.contains(&v.name) {
                    m.volumes_partial.push(v.name.clone());
                }
                if let Err(e) = cfg.save() {
                    out.problems.push(format!("Volume {}: could not record the copy: {e}", v.name));
                    continue;
                }
            }
            match copy_volume(source, target, v, (&helpers.0, &helpers.1)).await {
                Ok((files, bytes)) => {
                    out.volumes += 1;
                    copied_ok.insert(v.name.clone());
                    if v.action == "copy" {
                        job.log(format!("  {}, {} checked", plural(files, "entry", "entries"), gib(bytes)))
                            .await;
                    }
                    let mut cfg = state.config.lock().await;
                    let m = record(&mut cfg, req.from);
                    m.volumes_partial.retain(|n| n != &v.name);
                    if !m.volumes_done.contains(&v.name) {
                        m.volumes_done.push(v.name.clone());
                    }
                    if let Err(e) = cfg.save() {
                        job.log(format!("  Could not record {} as copied: {e}", v.name)).await;
                    }
                }
                Err(e) => {
                    job.log(format!("  {}: not copied: {e:#}", v.name)).await;
                    out.problems.push(format!("Volume {}: {e:#}", v.name));
                }
            }
        }
        job.done("volumes", Some(format!("{} of {} copied", out.volumes, vols.len())))
            .await;
    }

    job.start("networks").await;
    let networks = if req.projects { plan.networks.clone() } else { Vec::new() };
    if networks.is_empty() {
        job.skip("networks", "None needed").await;
    } else {
        let source_networks = source.list_networks(None::<ListNetworksOptions<String>>).await?;
        for name in &networks {
            let n = source_networks.iter().find(|n| n.name.as_deref() == Some(name.as_str()));
            let r = target
                .create_network(CreateNetworkOptions {
                    name: name.clone(),
                    driver: "bridge".into(),
                    internal: n.and_then(|n| n.internal).unwrap_or(false),
                    attachable: n.and_then(|n| n.attachable).unwrap_or(false),
                    labels: n.and_then(|n| n.labels.clone()).unwrap_or_default(),
                    ..Default::default()
                })
                .await;
            match r {
                Ok(_) => out.networks += 1,
                Err(e) => out.problems.push(format!("Network {name}: {e}")),
            }
        }
        job.done("networks", Some(format!("{} made", out.networks))).await;
    }

    job.start("projects").await;
    if projects.is_empty() {
        job.skip("projects", if req.projects { "None to recreate" } else { "Left out" })
            .await;
    } else {
        // A project only starts on its own data: one whose named volumes
        // aren't all in Orca (one failed, or volumes were left out) stays
        // in the source, or compose would start it on new, empty ones.
        let named: BTreeSet<&str> = plan.volumes.iter().map(|v| v.name.as_str()).collect();
        let present: BTreeSet<String> = volumes(target).await?.into_iter().map(|v| v.name).collect();
        for p in &projects {
            let missing: Vec<&str> = volumes_of(&containers, &plan.volumes, &p.name)
                .into_iter()
                .map(String::as_str)
                .filter(|v| named.contains(v) && !present.contains(*v))
                .collect();
            if !missing.is_empty() {
                job.log(format!(
                    "Project {}: not recreated, as {} isn't in Orca's engine",
                    p.name,
                    missing.join(", ")
                ))
                .await;
                out.problems.push(format!(
                    "Project {}: not recreated, as its volume {} didn't come over",
                    p.name,
                    missing.join(", ")
                ));
                continue;
            }
            match recreate(&state, &job, p).await {
                Ok(()) => out.projects += 1,
                Err(e) => {
                    job.log(format!("  {}: {e:#}", p.name)).await;
                    out.problems.push(format!("Project {}: {e:#}", p.name));
                }
            }
        }
        job.done("projects", Some(format!("{} of {} recreated", out.projects, projects.len())))
            .await;
    }

    job.start("verify").await;
    let mut missing = Vec::new();
    for i in &images {
        let failed = out
            .problems
            .iter()
            .any(|p| i.tags.iter().chain(&i.digests).any(|n| p.starts_with(&format!("Image {n}:"))));
        if !failed && !arrived(target, i).await {
            missing.push(format!("image {}", i.tags.first().or(i.digests.first()).cloned().unwrap_or_default()));
        }
    }
    let have: BTreeSet<String> = volumes(target).await?.into_iter().map(|v| v.name).collect();
    missing.extend(
        copied_ok
            .iter()
            .filter(|v| !have.contains(*v))
            .map(|v| format!("volume {v}")),
    );
    let now = all_containers(target).await?;
    let recreated: Vec<&&PlanProject> = projects
        .iter()
        .filter(|p| !out.problems.iter().any(|m| m.starts_with(&format!("Project {}:", p.name))))
        .collect();
    for p in recreated {
        for s in &p.services {
            let c = now.iter().find(|c| {
                label(&c.labels, "com.docker.compose.project") == Some(p.name.as_str())
                    && label(&c.labels, "com.docker.compose.service") == Some(s.name.as_str())
            });
            match c {
                None => missing.push(format!("{}'s {}", p.name, s.name)),
                Some(c) if s.running && c.state.as_deref() != Some("running") => {
                    missing.push(format!("{}'s {} (made, but stopped: see its logs)", p.name, s.name))
                }
                _ => {}
            }
        }
    }
    out.problems.extend(missing.into_iter().map(|m| format!("Missing {m}")));
    if out.problems.is_empty() {
        job.done("verify", Some("Everything is there".into())).await;
    } else {
        job.done(
            "verify",
            Some(format!(
                "{} didn't come over: see below",
                plural(out.problems.len() as u64, "thing", "things")
            )),
        )
        .await;
    }

    job.start("switch").await;
    if !req.switch_cli {
        job.skip("switch", "Left as it is").await;
    } else {
        match switch_cli(&target_engine).await {
            Ok(Some(done)) => job.done("switch", Some(done)).await,
            Ok(None) => job.skip("switch", "Nothing to change").await,
            Err(e) => {
                job.log(format!("Could not switch the docker context: {e:#}")).await;
                job.skip("switch", "Could not switch: see the log").await;
            }
        }
    }

    job.start("quit").await;
    if !req.quit_desktop || std::env::var("ORCA_DOCKER_DESKTOP_SOCKET").is_ok() {
        job.skip("quit", "Left running").await;
    } else {
        match stop_source(req.from).await {
            Ok(()) => job.done("quit", None).await,
            Err(e) => job.skip("quit", &format!("Could not stop it: {e:#}")).await,
        }
    }

    let mut cfg = state.config.lock().await;
    let m = record(&mut cfg, req.from);
    m.outcome = "moved".into();
    m.at = chrono::Utc::now().to_rfc3339();
    cfg.save()?;
    Ok(out)
}

/// The volumes a project uses: those its containers mount, and those
/// compose made for it.
fn volumes_of<'a>(
    containers: &'a [bollard::models::ContainerSummary],
    vols: &'a [PlanVolume],
    project: &str,
) -> BTreeSet<&'a String> {
    let mut out: BTreeSet<&String> = vols
        .iter()
        .filter(|v| v.project.as_deref() == Some(project))
        .map(|v| &v.name)
        .collect();
    for c in containers {
        if label(&c.labels, "com.docker.compose.project") == Some(project) {
            for m in c.mounts.iter().flatten() {
                if m.typ == Some(bollard::models::MountPointTypeEnum::VOLUME)
                    && let Some(n) = &m.name
                {
                    out.insert(n);
                }
            }
        }
    }
    out
}

/// Point the user's `docker` command at Orca's engine, when it points at
/// Docker Desktop's: the `lima-orca` context on macOS, the `default` one on
/// Linux. Windows has no `docker` command of Orca's to point.
async fn switch_cli(target: &Target) -> Result<Option<String>> {
    if cfg!(target_os = "macos") {
        if target.host != format!("unix://{}", engine::orca_socket()) {
            return Ok(None);
        }
        orca_backend_common::environment::switch_to_orca_runtime()
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        return Ok(Some("`docker` now talks to Orca's engine".into()));
    }
    if cfg!(windows) {
        return Ok(None);
    }
    let current = tokio::process::Command::new("docker")
        .env("PATH", crate::dev::ops::cli_path())
        .args(["context", "show"])
        .output()
        .await?;
    if String::from_utf8_lossy(&current.stdout).trim() != "desktop-linux" {
        return Ok(None);
    }
    let out = tokio::process::Command::new("docker")
        .env("PATH", crate::dev::ops::cli_path())
        .args(["context", "use", "default"])
        .output()
        .await?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(Some("`docker` now talks to the system's engine (context default)".into()))
}

/// Quit Docker Desktop, or stop the earlier Docker in the default distro.
async fn stop_source(from: From) -> Result<()> {
    match from {
        From::Earlier => {
            #[cfg(windows)]
            {
                let d = default_distro().await.context("no default WSL distro")?;
                orca_backend_common::wsl::sh(&d, "systemctl disable --now docker docker.socket 2>/dev/null || service docker stop", None)
                    .await?;
            }
            Ok(())
        }
        From::Desktop => {
            if cfg!(target_os = "macos") {
                orca_backend_common::environment::stop_docker_desktop()
                    .await
                    .map_err(|e| anyhow::anyhow!("{e}"))
            } else if cfg!(windows) {
                // Docker Desktop's own way out first (it stops its engine
                // cleanly); only then ask its window to close.
                let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
                let cli = Path::new(&pf).join(r"Docker\Docker\resources\bin\docker.exe");
                let stopped = tokio::process::Command::new(&cli)
                    .args(["desktop", "stop"])
                    .output()
                    .await
                    .is_ok_and(|o| o.status.success());
                if !stopped {
                    let _ = tokio::process::Command::new("taskkill")
                        .args(["/IM", "Docker Desktop.exe"])
                        .output()
                        .await;
                }
                Ok(())
            } else {
                let out = tokio::process::Command::new("systemctl")
                    .args(["--user", "stop", "docker-desktop"])
                    .output()
                    .await?;
                if !out.status.success() {
                    bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
                }
                Ok(())
            }
        }
    }
}

/// Create a compose project's containers in Orca's engine from its own
/// files, and start the services that were running.
async fn recreate(state: &AppState, job: &JobHandle, p: &PlanProject) -> Result<()> {
    job.log(format!("Project {} ({})", p.name, p.dir)).await;
    let all: Vec<&str> = p.services.iter().map(|s| s.name.as_str()).collect();
    compose(state, job, p, &["create", "--no-recreate"], &all).await?;
    let running: Vec<&str> = p.services.iter().filter(|s| s.running).map(|s| s.name.as_str()).collect();
    if !running.is_empty() {
        compose(state, job, p, &["up", "-d", "--no-recreate"], &running).await?;
    }
    Ok(())
}

/// `docker compose` on Orca's engine, as the project last ran: its name,
/// folder, compose files and env files.
async fn compose(state: &AppState, job: &JobHandle, p: &PlanProject, args: &[&str], services: &[&str]) -> Result<()> {
    let mut cmd = crate::dev::ops::runtime_cli(state, "docker").await;
    cmd.current_dir(&p.dir)
        .args(["compose", "-p", &p.name, "--project-directory", &p.dir]);
    for f in &p.files {
        cmd.args(["-f", f]);
    }
    for e in &p.env_files {
        cmd.args(["--env-file", e]);
    }
    cmd.args(args).args(services);
    let cmd = cmd.on_engine();
    let shown = format!("docker compose -p {} {} {}", p.name, args.join(" "), services.join(" "));
    crate::workspace::run_logged(job, cmd, shown.trim()).await
}

// --- API -----------------------------------------------------------------------

/// Docker Desktop on this Mac: installed, running, what's in it, and whether
/// it was brought over (or left) already.
async fn status(State(state): State<Arc<AppState>>, Query(q): Query<FromQuery>) -> Json<serde_json::Value> {
    let found = source(q.from).await;
    let installed = match q.from {
        From::Desktop => desktop_installed(),
        From::Earlier => found.is_some(),
    };
    let outcome = {
        let cfg = state.config.lock().await;
        match q.from {
            From::Desktop => cfg.docker_desktop.clone(),
            From::Earlier => cfg.earlier_engine.clone(),
        }
    };
    let mut counts = serde_json::Value::Null;
    let name = found.as_ref().map(|s| s.name.clone());
    let running = match found.map(|s| s.docker) {
        Some(d) => {
            let containers = all_containers(&d).await.map(|c| c.len()).unwrap_or(0);
            let images = d
                .list_images(None::<ListImagesOptions<String>>)
                .await
                .map(|i| i.len())
                .unwrap_or(0);
            let vols = volumes(&d).await.map(|v| v.iter().filter(|v| !anonymous(v)).count()).unwrap_or(0);
            counts = serde_json::json!({ "containers": containers, "images": images, "volumes": vols });
            true
        }
        None => false,
    };
    let orca_ready = orca_engine(&state).await.is_ok();
    Json(serde_json::json!({
        "installed": installed,
        "running": running,
        "counts": counts,
        "outcome": outcome.as_ref().map(|m| &m.outcome).filter(|o| !o.is_empty()),
        "moved_at": outcome.as_ref().map(|m| &m.at).filter(|a| !a.is_empty()),
        "orca_ready": orca_ready,
        "moving": MOVING.load(Ordering::SeqCst),
        "name": name,
    }))
}

async fn plan_route(State(state): State<Arc<AppState>>, Query(q): Query<FromQuery>) -> Result<Json<Plan>, ApiError> {
    let src = source(q.from).await.ok_or_else(|| {
        ApiError::bad_request(match q.from {
            From::Desktop => "Docker Desktop isn't running",
            From::Earlier => "The earlier Docker isn't running",
        })
    })?;
    let p = plan(&state, &src, q.from)
        .await
        .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(p))
}

/// Open Docker Desktop and wait for its engine, to see what's in it.
async fn start_desktop(Query(q): Query<FromQuery>) -> Result<Json<serde_json::Value>, ApiError> {
    if source(q.from).await.is_some() {
        return Ok(Json(serde_json::json!({ "running": true })));
    }
    let opened = match q.from {
        From::Earlier => {
            #[cfg(windows)]
            {
                match default_distro().await {
                    Some(d) => orca_backend_common::wsl::sh(&d, "service docker start", None).await.is_ok(),
                    None => false,
                }
            }
            #[cfg(not(windows))]
            false
        }
        From::Desktop if cfg!(windows) => {
            let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
            tokio::process::Command::new(Path::new(&pf).join(r"Docker\Docker\Docker Desktop.exe"))
                .spawn()
                .is_ok()
        }
        From::Desktop if cfg!(target_os = "macos") => tokio::process::Command::new("open")
            .args(["-a", "Docker"])
            .status()
            .await
            .is_ok_and(|s| s.success()),
        From::Desktop => tokio::process::Command::new("systemctl")
            .args(["--user", "start", "docker-desktop"])
            .status()
            .await
            .is_ok_and(|s| s.success()),
    };
    if !opened {
        return Err(ApiError::bad_request("Could not open Docker Desktop"));
    }
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if source(q.from).await.is_some() {
            return Ok(Json(serde_json::json!({ "running": true })));
        }
    }
    Err(ApiError::bad_request(
        "Docker Desktop didn't start within two minutes. Open it yourself, then try again.",
    ))
}

async fn move_route(
    State(state): State<Arc<AppState>>,
    body: Option<Json<MoveRequest>>,
) -> Result<axum::response::Response, ApiError> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    if MOVING.swap(true, Ordering::SeqCst) {
        return Err(ApiError::bad_request("Already bringing things over from Docker Desktop"));
    }
    // Released however the move ends (even a panic).
    struct Moving;
    impl Drop for Moving {
        fn drop(&mut self) {
            MOVING.store(false, Ordering::SeqCst);
        }
    }
    let job = JobHandle::create(
        match req.from {
            From::Desktop => "docker-desktop",
            From::Earlier => "docker-desktop-earlier",
        },
        None,
        "move",
        &[
            ("check", "Check both engines and the space"),
            ("stop", "Stop what uses the volumes, in Docker Desktop"),
            ("images", "Copy the images"),
            ("volumes", "Copy the volumes"),
            ("networks", "Make the networks projects join"),
            ("projects", "Recreate the compose projects"),
            ("verify", "Check everything arrived"),
            ("switch", "Point the docker command at Orca's engine"),
            ("quit", "Quit Docker Desktop"),
        ],
    )
    .await;
    let j = job.clone();
    tokio::spawn(async move {
        let _moving = Moving;
        match run_move(state, j.clone(), req).await {
            Ok(out) => j.succeed(Some(serde_json::to_value(out).unwrap_or_default())).await,
            Err(e) => j.fail(&e).await,
        }
    });
    Ok((axum::http::StatusCode::ACCEPTED, Json(job.snapshot().await)).into_response())
}

/// Leave Docker Desktop's things where they are: Orca stops offering to move them.
async fn leave(State(state): State<Arc<AppState>>, Query(q): Query<FromQuery>) -> Result<Json<serde_json::Value>, ApiError> {
    let mut cfg = state.config.lock().await;
    let m = record(&mut cfg, q.from);
    if m.outcome.is_empty() {
        m.outcome = "left".into();
        m.at = chrono::Utc::now().to_rfc3339();
    }
    cfg.save()?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn quit(Query(q): Query<FromQuery>) -> Result<Json<serde_json::Value>, ApiError> {
    stop_source(q.from).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, kind: u8, size: u64) -> Vec<u8> {
        let mut h = vec![0u8; 512];
        h[..name.len()].copy_from_slice(name.as_bytes());
        let s = format!("{size:011o}\0");
        h[124..136].copy_from_slice(s.as_bytes());
        h[156] = kind;
        h
    }

    fn tar(entries: &[(&str, u8, u64)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, kind, size) in entries {
            out.extend(header(name, *kind, *size));
            out.extend(vec![7u8; (size.div_ceil(512) * 512) as usize]);
        }
        out.extend(vec![0u8; 1024]);
        out
    }

    #[test]
    fn tallies_entries_and_bytes_in_any_chunking() {
        let t = tar(&[
            ("orca-move/", b'5', 0),
            ("././@PaxHeader", b'x', 30),
            ("orca-move/a", b'0', 1000),
            ("orca-move/b", b'0', 512),
            ("orca-move/l", b'2', 0),
        ]);
        for chunk in [1, 7, 512, 513, 4096, t.len()] {
            let mut tally = TarTally::default();
            for c in t.chunks(chunk) {
                tally.feed(c);
            }
            assert_eq!((tally.entries, tally.bytes, tally.ended), (4, 1512, true), "chunk {chunk}");
        }
    }

    #[test]
    fn a_cut_off_tar_has_not_ended() {
        let t = tar(&[("orca-move/a", b'0', 2000)]);
        let mut tally = TarTally::default();
        tally.feed(&t[..1500]);
        assert!(!tally.ended);
    }

    #[test]
    fn pax_sizes_count_for_the_next_entry() {
        // dockerd (Go's archive/tar) puts sizes of 8 GiB and up in a PAX
        // record, with 0 in the entry's own header.
        let rec = b"13 size=1000\n";
        let mut t = header("././@PaxHeader", b'x', rec.len() as u64);
        let mut data = rec.to_vec();
        data.resize(512, 0);
        t.extend(data);
        t.extend(header("orca-move/big", b'0', 0));
        t.extend(vec![7u8; 1024]);
        t.extend(vec![0u8; 1024]);
        let mut tally = TarTally::default();
        for c in t.chunks(100) {
            tally.feed(c);
        }
        assert_eq!((tally.entries, tally.bytes, tally.ended), (1, 1000, true));
    }

    #[test]
    fn images_come_back_by_digest() {
        let digests = vec!["postgres@sha256:abc".to_string(), "registry.acme.dev:5000/tools/x@sha256:def".to_string()];
        assert_eq!(digest_for("postgres:16", &digests).as_deref(), Some("postgres@sha256:abc"));
        assert_eq!(
            digest_for("registry.acme.dev:5000/tools/x:1", &digests).as_deref(),
            Some("registry.acme.dev:5000/tools/x@sha256:def")
        );
        assert_eq!(digest_for("mysql:8", &digests), None);
        assert_eq!(split_tag("registry.acme.dev:5000/tools/x"), ("registry.acme.dev:5000/tools/x", "latest"));
        let opts = HashMap::from([("device".to_string(), "/run/desktop/mnt/host/c/code".to_string())]);
        assert_eq!(target_options(&opts)["device"], "/mnt/c/code");
    }

    #[test]
    fn reads_large_sizes_in_base_256() {
        let mut f = [0u8; 12];
        f[0] = 0x80;
        f[7] = 0x02; // 2 << 32
        assert_eq!(tar_size(&f), 2u64 << 32);
        assert_eq!(tar_size(b"00000001750\0"), 1000);
    }

    #[test]
    fn anonymous_volumes_are_told_apart() {
        let v = |name: &str| bollard::models::Volume {
            name: name.into(),
            ..Default::default()
        };
        assert!(anonymous(&v(&"a".repeat(64))));
        assert!(!anonymous(&v("shop_db")));
    }

    #[test]
    fn stops_only_what_uses_what_moves() {
        let c = |name: &str, project: Option<&str>, volume: Option<&str>, running: bool| {
            bollard::models::ContainerSummary {
                names: Some(vec![format!("/{name}")]),
                labels: project.map(|p| HashMap::from([("com.docker.compose.project".to_string(), p.to_string())])),
                state: Some(if running { "running" } else { "exited" }.into()),
                mounts: volume.map(|v| {
                    vec![bollard::models::MountPoint {
                        typ: Some(bollard::models::MountPointTypeEnum::VOLUME),
                        name: Some(v.into()),
                        ..Default::default()
                    }]
                }),
                ..Default::default()
            }
        };
        let containers = vec![
            c("shop-db-1", Some("shop"), Some("shop_db"), true),
            c("blog-web-1", Some("blog"), None, true),
            c("cache", None, Some("cache"), true),
            c("idle", None, Some("idle"), true),
            c("old", Some("shop"), None, false),
        ];
        let project = |name: &str| PlanProject {
            name: name.into(),
            dir: "/x".into(),
            files: vec![],
            env_files: vec![],
            services: vec![],
            problem: None,
            in_orca: false,
        };
        let volume = |name: &str, action: &'static str| PlanVolume {
            name: name.into(),
            size: None,
            action,
            note: None,
            project: None,
            driver: "local".into(),
            options: HashMap::new(),
            labels: HashMap::new(),
            in_orca: None,
        };
        let projects = vec![project("shop"), project("blog")];
        let vols = vec![volume("shop_db", "copy"), volume("cache", "copy"), volume("idle", "define")];
        let skip = BTreeSet::from(["blog".to_string()]);
        assert_eq!(to_stop(&containers, &projects, &vols, Some(&skip)), vec!["cache", "shop-db-1"]);
    }
}
