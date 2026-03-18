use serde::Serialize;
use tauri::Manager;

mod commands;

#[derive(Debug, Serialize, Clone)]
struct DaemonStatus {
    connected: bool,
    version: Option<String>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::list_containers,
            commands::list_images,
            commands::list_volumes,
            commands::get_machine_info,
        ])
        .setup(|app| {
            // TODO: Start the daemon process if not already running.
            // TODO: Set up system tray icon.
            let _window = app.get_webview_window("main").unwrap();
            tracing::info!("Vessel GUI started");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running vessel");
}
