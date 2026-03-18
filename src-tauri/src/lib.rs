mod commands;

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
            commands::list_images,
            commands::remove_image,
            commands::list_volumes,
            commands::remove_volume,
            commands::list_networks,
            commands::get_machine_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running vessel");
}
