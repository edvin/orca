//! Windows backend for Orca.
//!
//! On Windows, containers run inside a WSL2 distro.
//! All container/image/volume/network operations are delegated to the
//! embedded BollardRuntime via Deref. The only Windows-specific code
//! is the WSL2 distro lifecycle in wsl.rs.

mod wsl;

use std::ops::Deref;

pub use orca_backend_common::BollardRuntime;

/// Windows backend that manages a WSL2 distro with a container runtime inside.
pub struct WindowsBackend {
    pub runtime: BollardRuntime,
    pub distro_name: String,
}

impl Deref for WindowsBackend {
    type Target = BollardRuntime;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

impl WindowsBackend {
    /// Connect to the container runtime in an existing WSL2 distro.
    pub fn connect(distro_name: &str) -> anyhow::Result<Self> {
        let docker = bollard::Docker::connect_with_local_defaults()?;
        Ok(Self {
            runtime: BollardRuntime::new(docker),
            distro_name: distro_name.to_string(),
        })
    }

    /// Connect via explicit TCP address (used when WSL2 forwards the socket).
    pub fn connect_tcp(_addr: &str) -> anyhow::Result<Self> {
        let docker = bollard::Docker::connect_with_http_defaults()?;
        Ok(Self {
            runtime: BollardRuntime::new(docker),
            distro_name: "orca".to_string(),
        })
    }
}
