use std::path::PathBuf;

fn main() {
    // Ensure the external binary stub exists so `cargo check` works
    // without needing to build the daemon first.
    // The real binary is placed here by the build/release pipeline.
    let target = std::env::var("TAURI_ENV_TARGET_TRIPLE")
        .or_else(|_| std::env::var("TARGET"))
        .unwrap_or_else(|_| "x86_64-unknown-linux-gnu".into());

    let bin_dir = PathBuf::from("binaries");
    let bin_name = if target.contains("windows") {
        format!("orca-daemon-{target}.exe")
    } else {
        format!("orca-daemon-{target}")
    };
    let bin_path = bin_dir.join(&bin_name);

    if !bin_path.exists() {
        std::fs::create_dir_all(&bin_dir).ok();
        // Create an empty stub — enough to pass Tauri's resource check.
        // It will be replaced by the actual daemon binary at build time.
        std::fs::write(&bin_path, b"").ok();
        println!("cargo:warning=Created stub binary at {}, build the daemon for a real binary", bin_path.display());
    }

    tauri_build::build()
}
