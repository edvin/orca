//! Shared bollard-based container runtime logic.
//!
//! All Orca backends (native, macOS, Windows) talk to Docker/Podman
//! through the same Docker-compatible API. This crate provides the
//! shared implementation so each backend only needs to handle
//! platform-specific VM/machine management.

pub mod compose;
pub mod containers;
pub mod environment;
pub mod events;
pub mod export;
pub mod images;
pub mod k8s;
pub mod networks;
pub mod search;
pub mod templates;
pub mod volumes;
pub mod wsl;

/// How long the engine version is reused before asking the engine again.
const VERSION_TTL: std::time::Duration = std::time::Duration::from_secs(3600);

/// How long `GET /system/df` is reused. It walks every image, container,
/// volume and build-cache record and costs dockerd and containerd several
/// CPU seconds on a busy engine, while the health it feeds is polled every
/// few seconds.
const DISK_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// How long the container list is reused. Docker events drop it as soon as
/// a container changes, so this only bounds staleness if events are missed.
/// The GUI asks for the list from several places every few seconds, and
/// each `GET /containers/json` costs dockerd and containerd ~0.15 CPU s.
const CONTAINERS_TTL: std::time::Duration = std::time::Duration::from_secs(10);

/// How long the image list is reused; image events drop it sooner. With the
/// containerd image store, `GET /images/json` sizes every image and costs
/// over a CPU second with a few dozen images.
const IMAGES_TTL: std::time::Duration = std::time::Duration::from_secs(300);

/// How long the stats of all running containers are reused, so that several
/// views polling at once cost one round of stats requests.
const STATS_TTL: std::time::Duration = std::time::Duration::from_secs(2);

/// Shared container runtime client backed by bollard.
/// Each platform backend embeds this and delegates trait impls to it.
pub struct BollardRuntime {
    pub docker: bollard::Docker,
    /// Engine address (`unix:///…/docker.sock`) when connected over a socket.
    /// Child `docker`/`podman` CLI processes get it as `DOCKER_HOST`, so they
    /// reach the same engine as the API client whatever the CLI context says.
    pub host: Option<String>,
    version: tokio::sync::Mutex<Option<(std::time::Instant, bollard::system::Version)>>,
    disk: std::sync::Arc<TtlCache<DiskSnapshot>>,
    containers: std::sync::Arc<TtlCache<Vec<orca_core::runtime::Container>>>,
    images: std::sync::Arc<TtlCache<Vec<orca_core::image::Image>>>,
    stats: TtlCache<Vec<orca_core::runtime::ContainerStats>>,
    /// Each container's last CPU reading (container total, host total), to
    /// work out CPU % between two polls: one-shot stats carry no previous
    /// reading of their own.
    cpu_samples: std::sync::Mutex<std::collections::HashMap<String, (u64, u64)>>,
    /// Docker events as Orca events, fed by one stream per runtime that
    /// starts on the first subscription (see `subscribe_events`).
    events: tokio::sync::broadcast::Sender<orca_core::event::Event>,
    events_started: std::sync::Once,
    /// Dropped with the runtime, which ends its event stream.
    alive: tokio::sync::watch::Sender<()>,
}

impl BollardRuntime {
    pub fn new(docker: bollard::Docker) -> Self {
        Self {
            docker,
            host: None,
            version: tokio::sync::Mutex::new(None),
            disk: std::sync::Arc::new(TtlCache::new(DISK_TTL)),
            containers: std::sync::Arc::new(TtlCache::new(CONTAINERS_TTL)),
            images: std::sync::Arc::new(TtlCache::new(IMAGES_TTL)),
            stats: TtlCache::new(STATS_TTL),
            cpu_samples: Default::default(),
            events: tokio::sync::broadcast::channel(256).0,
            events_started: std::sync::Once::new(),
            alive: tokio::sync::watch::channel(()).0,
        }
    }

    /// Record the unix socket this runtime is connected through.
    /// The engine's address for child CLIs (`unix://…`, `tcp://…`).
    pub fn with_host(mut self, host: impl Into<String>) -> Self {
        self.host = Some(host.into());
        self
    }

    pub fn with_socket(mut self, path: impl AsRef<std::path::Path>) -> Self {
        self.host = Some(format!("unix://{}", path.as_ref().display()));
        self
    }

    /// The engine's `GET /version`, cached for [`VERSION_TTL`]. A reconnect
    /// builds a new runtime, so it starts fresh.
    ///
    /// Don't call `docker.version()` directly: rootless dockerd (29.x, as in
    /// Orca's Lima VM) leaks a connection to rootlesskit's API socket on every
    /// `/version`, about 50 KB each, until the VM's OOM killer takes dockerd.
    /// To check that the engine is reachable, use `docker.ping()`.
    pub async fn server_version(&self) -> Result<bollard::system::Version, bollard::errors::Error> {
        let mut cached = self.version.lock().await;
        if let Some((at, v)) = cached.as_ref()
            && at.elapsed() < VERSION_TTL
        {
            return Ok(v.clone());
        }
        let v = self.docker.version().await?;
        *cached = Some((std::time::Instant::now(), v.clone()));
        Ok(v)
    }

    /// Drop the cached version, e.g. after the engine was updated.
    pub async fn forget_version(&self) {
        *self.version.lock().await = None;
    }

    /// The engine's disk usage (`GET /system/df`), cached for [`DISK_TTL`].
    /// `force` recomputes it. Concurrent callers share one computation, so
    /// several pollers or a burst of refreshes cost the engine one walk.
    pub async fn disk_usage(&self, force: bool) -> Result<orca_core::environment::DiskUsage, bollard::errors::Error> {
        Ok(self.disk_snapshot(force).await?.usage)
    }

    /// Size of each volume in bytes, from the same `GET /system/df` walk as
    /// [`disk_usage`](Self::disk_usage) and cached with it.
    pub async fn volume_sizes(
        &self,
        force: bool,
    ) -> Result<std::collections::HashMap<String, u64>, bollard::errors::Error> {
        Ok(self.disk_snapshot(force).await?.volume_sizes)
    }

    async fn disk_snapshot(&self, force: bool) -> Result<DiskSnapshot, bollard::errors::Error> {
        self.disk
            .get(force, || async {
                let df = self.docker.df().await?;
                let volume_sizes = df
                    .volumes
                    .iter()
                    .flatten()
                    .filter_map(|v| {
                        let size = v.usage_data.as_ref()?.size;
                        Some((v.name.clone(), u64::try_from(size).ok()?))
                    })
                    .collect();
                Ok(DiskSnapshot {
                    usage: environment::summarize_disk_usage(&df),
                    volume_sizes,
                })
            })
            .await
    }

    /// The cached disk usage however old, without waiting for the engine.
    /// A missing or stale value is recomputed in the background for later
    /// callers: health is polled, and `df` can take several seconds.
    pub fn cached_disk_usage(self: &std::sync::Arc<Self>) -> Option<orca_core::environment::DiskUsage> {
        let (value, due) = self.disk.peek();
        let value = value.map(|s| s.usage);
        if due {
            let rt = self.clone();
            tokio::spawn(async move {
                if let Err(e) = rt.disk_usage(false).await {
                    tracing::debug!("system/df failed: {e}");
                }
            });
        }
        value
    }

    /// Drop the cached disk usage, e.g. after images or volumes were removed.
    pub fn forget_disk(&self) {
        self.disk.forget();
    }

    /// Drop the cached container list after changing a container. Docker's
    /// events do it too, but they arrive a moment after the change.
    pub fn forget_containers(&self) {
        self.containers.forget();
    }

    /// Drop the cached image list after changing images.
    pub fn forget_images(&self) {
        self.images.forget();
    }

    /// Detect whether we're talking to Docker or Podman.
    pub async fn detect_runtime(&self) -> orca_core::runtime::RuntimeKind {
        if let Ok(version) = self.server_version().await
            && let Some(components) = version.components
        {
            for c in &components {
                if c.name.to_lowercase().contains("podman") {
                    return orca_core::runtime::RuntimeKind::Podman;
                }
            }
        }
        orca_core::runtime::RuntimeKind::Docker
    }
}

/// What one `GET /system/df` walk yields, cached as a whole.
#[derive(Clone)]
struct DiskSnapshot {
    usage: orca_core::environment::DiskUsage,
    volume_sizes: std::collections::HashMap<String, u64>,
}

/// A value that is reused for `ttl` and computed by one caller at a time.
///
/// Callers of [`get`](Self::get) that arrive during a computation wait for it
/// and take its result instead of starting their own, including forced ones,
/// which only recompute a value older than their own request.
/// [`peek`](Self::peek) reads the last value without waiting.
struct TtlCache<T> {
    ttl: std::time::Duration,
    /// Held while computing.
    computing: tokio::sync::Mutex<()>,
    value: std::sync::Mutex<Option<(std::time::Instant, T)>>,
    /// Bumped by `forget`, so a computation that started before it isn't kept.
    generation: std::sync::atomic::AtomicU64,
}

impl<T: Clone> TtlCache<T> {
    fn new(ttl: std::time::Duration) -> Self {
        Self {
            ttl,
            computing: tokio::sync::Mutex::new(()),
            value: std::sync::Mutex::new(None),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    async fn get<F, Fut, E>(&self, force: bool, compute: F) -> Result<T, E>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
    {
        let asked = std::time::Instant::now();
        let _computing = self.computing.lock().await;
        if let Some((at, v)) = self.value.lock().unwrap().as_ref() {
            let fresh = if force { *at >= asked } else { at.elapsed() < self.ttl };
            if fresh {
                return Ok(v.clone());
            }
        }
        let generation = self.generation.load(std::sync::atomic::Ordering::SeqCst);
        let v = compute().await?;
        if self.generation.load(std::sync::atomic::Ordering::SeqCst) == generation {
            *self.value.lock().unwrap() = Some((std::time::Instant::now(), v.clone()));
        }
        Ok(v)
    }

    /// The last value however old, and whether it is due for recomputing
    /// (missing or older than the TTL) with no computation running.
    fn peek(&self) -> (Option<T>, bool) {
        let idle = self.computing.try_lock().is_ok();
        match self.value.lock().unwrap().as_ref() {
            Some((at, v)) => (Some(v.clone()), idle && at.elapsed() >= self.ttl),
            None => (None, idle),
        }
    }

    fn forget(&self) {
        self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.value.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::TtlCache;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn counting(calls: &Arc<AtomicUsize>) -> impl std::future::Future<Output = Result<usize, ()>> + use<> {
        let calls = calls.clone();
        async move { Ok(calls.fetch_add(1, Ordering::SeqCst) + 1) }
    }

    #[tokio::test]
    async fn reuses_the_value_within_the_ttl() {
        let cache = TtlCache::new(Duration::from_secs(600));
        let calls = Arc::new(AtomicUsize::new(0));
        assert_eq!(cache.get(false, || counting(&calls)).await, Ok(1));
        assert_eq!(cache.get(false, || counting(&calls)).await, Ok(1));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn recomputes_after_the_ttl() {
        let cache = TtlCache::new(Duration::from_millis(20));
        let calls = Arc::new(AtomicUsize::new(0));
        cache.get(false, || counting(&calls)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(cache.get(false, || counting(&calls)).await, Ok(2));
    }

    #[tokio::test]
    async fn force_recomputes() {
        let cache = TtlCache::new(Duration::from_secs(600));
        let calls = Arc::new(AtomicUsize::new(0));
        cache.get(false, || counting(&calls)).await.unwrap();
        assert_eq!(cache.get(true, || counting(&calls)).await, Ok(2));
    }

    #[tokio::test]
    async fn forget_invalidates() {
        let cache = TtlCache::new(Duration::from_secs(600));
        let calls = Arc::new(AtomicUsize::new(0));
        cache.get(false, || counting(&calls)).await.unwrap();
        cache.forget();
        assert_eq!(cache.get(false, || counting(&calls)).await, Ok(2));
    }

    /// A value computed from before a `forget` is returned but not kept.
    #[tokio::test]
    async fn forget_during_a_computation_discards_its_result() {
        let cache = TtlCache::new(Duration::from_secs(600));
        let calls = Arc::new(AtomicUsize::new(0));
        let v = cache
            .get(false, || {
                cache.forget();
                counting(&calls)
            })
            .await;
        assert_eq!(v, Ok(1));
        assert_eq!(cache.peek(), (None, true));
        assert_eq!(cache.get(false, || counting(&calls)).await, Ok(2));
    }

    #[tokio::test]
    async fn peek_returns_stale_values_and_says_they_are_due() {
        let cache = TtlCache::new(Duration::from_millis(20));
        assert_eq!(cache.peek(), (None::<usize>, true));
        cache.get(false, || async { Ok::<_, ()>(1) }).await.unwrap();
        assert_eq!(cache.peek(), (Some(1), false));
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(cache.peek(), (Some(1), true));
    }

    /// While a computation runs, nothing is due: it will refresh the value.
    #[tokio::test]
    async fn peek_during_a_computation_is_not_due() {
        let cache = TtlCache::new(Duration::from_secs(600));
        let (_, peeked) = tokio::join!(
            cache.get(false, || async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok::<_, ()>(1)
            }),
            async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                cache.peek()
            },
        );
        assert_eq!(peeked, (None, false));
        assert_eq!(cache.peek(), (Some(1), false));
    }

    #[tokio::test]
    async fn errors_are_not_cached() {
        let cache = TtlCache::new(Duration::from_secs(600));
        assert_eq!(
            cache.get(false, || async { Err::<usize, _>("down") }).await,
            Err("down")
        );
        assert_eq!(cache.get(false, || async { Ok::<_, &str>(7) }).await, Ok(7));
    }

    /// Concurrent callers, forced or not, share one computation.
    #[tokio::test]
    async fn concurrent_calls_compute_once() {
        let cache = Arc::new(TtlCache::new(Duration::from_secs(600)));
        let calls = Arc::new(AtomicUsize::new(0));
        let slow = |calls: Arc<AtomicUsize>| async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok::<_, ()>(calls.fetch_add(1, Ordering::SeqCst) + 1)
        };
        let (a, b, c) = tokio::join!(
            cache.get(false, || slow(calls.clone())),
            cache.get(true, || slow(calls.clone())),
            cache.get(true, || slow(calls.clone())),
        );
        assert_eq!((a, b, c), (Ok(1), Ok(1), Ok(1)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
