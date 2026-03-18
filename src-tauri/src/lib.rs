mod commands;
mod tray;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::list_containers,
            commands::inspect_container,
            commands::container_stats,
            commands::start_container,
            commands::stop_container,
            commands::remove_container,
            commands::container_logs,
            commands::list_images,
            commands::pull_image,
            commands::remove_image,
            commands::list_volumes,
            commands::remove_volume,
            commands::list_networks,
            commands::list_stacks,
            commands::get_stack,
            commands::start_stack,
            commands::stop_stack,
            commands::restart_stack,
            commands::compose_up,
            commands::compose_down,
            commands::compose_pull,
            commands::subscribe_events,
            commands::get_machine_info,
        ])
        .setup(|app| {
            tray::setup_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running vessel");
}
