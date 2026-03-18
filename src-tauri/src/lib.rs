mod commands;
mod daemon;
mod tray;

use std::sync::Arc;

pub fn run() {
    let daemon_manager = Arc::new(daemon::DaemonManager::new());
    let dm = daemon_manager.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(daemon_manager)
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::list_containers,
            commands::inspect_container,
            commands::container_stats,
            commands::start_container,
            commands::stop_container,
            commands::exec_container,
            commands::remove_container,
            commands::create_and_run_container,
            commands::container_logs,
            commands::list_images,
            commands::pull_image,
            commands::remove_image,
            commands::batch_delete_images,
            commands::prune_images,
            commands::build_image,
            commands::list_volumes,
            commands::remove_volume,
            commands::create_volume,
            commands::inspect_image,
            commands::list_networks,
            commands::create_network,
            commands::remove_network,
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
            commands::k8s_status,
            commands::k8s_enable,
            commands::k8s_disable,
            commands::k8s_namespaces,
            commands::k8s_pods,
            commands::k8s_deployments,
            commands::k8s_services,
            commands::k8s_ingresses,
            commands::k8s_pvcs,
            commands::k8s_pvs,
            commands::k8s_delete_pod,
            commands::k8s_delete_pvc,
            commands::k8s_scale_deployment,
            commands::k8s_restart_deployment,
            commands::k8s_pod_logs,
            commands::k8s_apply_yaml,
            commands::env_status,
            commands::env_fix,
        ])
        .setup(move |app| {
            tray::setup_tray(app.handle())?;

            // Auto-start daemon in background
            let dm_setup = dm.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = dm_setup.start().await {
                    tracing::warn!("Failed to auto-start daemon: {e}");
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running orca");
}
