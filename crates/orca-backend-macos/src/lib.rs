//! macOS backend for Orca.
//!
//! On macOS, containers run inside a lightweight Linux VM managed by Lima.
//! All container/image/volume/network operations are delegated to the
//! embedded BollardRuntime via Deref, just like the native backend.
//! The only macOS-specific code is the VM lifecycle in vm.rs.

mod vm;

use std::ops::Deref;
use std::path::PathBuf;

pub use orca_backend_common::BollardRuntime;

/// macOS backend that manages a Lima VM with a container runtime inside.
pub struct MacOSBackend {
    pub runtime: BollardRuntime,
    pub socket_path: PathBuf,
    pub vm_name: String,
}

impl Deref for MacOSBackend {
    type Target = BollardRuntime;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

impl MacOSBackend {
    /// Connect to an existing Lima VM's container runtime.
    pub fn connect(vm_name: &str) -> anyhow::Result<Self> {
        let socket_path = lima_socket_path(vm_name);

        if !socket_path.exists() {
            anyhow::bail!(
                "Lima VM '{vm_name}' socket not found at {}. \
                 Is the VM running? Try: limactl start {vm_name}",
                socket_path.display()
            );
        }

        let docker = bollard::Docker::connect_with_socket(
            socket_path.to_str().ok_or_else(|| anyhow::anyhow!("Invalid socket path"))?,
            120,
            bollard::API_DEFAULT_VERSION,
        )?;

        Ok(Self {
            runtime: BollardRuntime::new(docker),
            socket_path,
            vm_name: vm_name.to_string(),
        })
    }
}

fn lima_socket_path(vm_name: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".lima")
        .join(vm_name)
        .join("sock")
        .join("docker.sock")
}
