// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Workaround for WebKitGTK EGL crash on some Linux setups (Manjaro, Wayland, etc.)
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            // SAFETY: called before any threads are spawned (start of main)
            unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1"); }
        }

        // Workaround for Wayland libwayland-client version mismatch in AppImage.
        // The AppImage bundles an older libwayland-client that conflicts with the
        // system's version. LD_PRELOAD must be set before process start, so we
        // re-exec ourselves with it set.
        if std::env::var("WAYLAND_DISPLAY").is_ok()
            && std::env::var("__ORCA_WAYLAND_FIX").is_err()
        {
            let wayland_lib = "/usr/lib/libwayland-client.so";
            // Also check multilib path
            let wayland_lib_64 = "/usr/lib64/libwayland-client.so";
            let lib_path = if std::path::Path::new(wayland_lib).exists() {
                Some(wayland_lib)
            } else if std::path::Path::new(wayland_lib_64).exists() {
                Some(wayland_lib_64)
            } else {
                None
            };

            if let Some(lib) = lib_path {
                // Set marker to prevent infinite re-exec loop
                // SAFETY: called before any threads are spawned (start of main)
                unsafe { std::env::set_var("__ORCA_WAYLAND_FIX", "1"); }
                // Prepend to existing LD_PRELOAD
                let existing = std::env::var("LD_PRELOAD").unwrap_or_default();
                let preload = if existing.is_empty() {
                    lib.to_string()
                } else {
                    format!("{lib}:{existing}")
                };
                let exe = std::env::current_exe().expect("failed to get current exe");
                let err = exec_with_preload(&exe, &preload);
                eprintln!("Failed to re-exec with LD_PRELOAD: {err}");
                // Fall through and try without it
            }
        }
    }

    orca_gui_lib::run()
}

/// Re-exec the current process with LD_PRELOAD set.
#[cfg(target_os = "linux")]
fn exec_with_preload(exe: &std::path::Path, preload: &str) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    let mut cmd = std::process::Command::new(exe);
    cmd.args(std::env::args().skip(1));
    cmd.env("LD_PRELOAD", preload);
    // exec replaces the current process — only returns on error
    cmd.exec()
}
