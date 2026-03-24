mod commands;
mod daemon;
mod tray;

use std::sync::Arc;

pub fn run() {
    let daemon_manager = Arc::new(daemon::DaemonManager::new());
    let dm = daemon_manager.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            commands::update_container,
            commands::export_docker_run,
            commands::export_compose,
            commands::container_list_files,
            commands::container_read_file,
            commands::commit_container,
            commands::create_and_run_container,
            commands::container_logs,
            commands::list_registries,
            commands::add_registry,
            commands::remove_registry,
            commands::search_images,
            commands::list_images,
            commands::pull_image,
            commands::remove_image,
            commands::batch_delete_images,
            commands::prune_images,
            commands::tag_image,
            commands::build_image,
            commands::list_volumes,
            commands::remove_volume,
            commands::create_volume,
            commands::volume_list_files,
            commands::volume_read_file,
            commands::volume_containers,
            commands::inspect_image,
            commands::image_history,
            commands::image_list_files,
            commands::image_read_file,
            commands::import_image,
            commands::scan_image,
            commands::list_networks,
            commands::create_network,
            commands::remove_network,
            commands::network_topology,
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
            commands::k8s_get_yaml,
            commands::k8s_events,
            commands::k8s_create_namespace,
            commands::k8s_delete_namespace,
            commands::k8s_configmaps,
            commands::k8s_secrets,
            commands::k8s_create_secret,
            commands::k8s_delete_secret,
            commands::k8s_update_secret,
            commands::k8s_create_pvc,
            commands::k8s_pod_metrics,
            commands::k8s_rollout_history,
            commands::k8s_rollout_undo,
            commands::k8s_daemonsets,
            commands::k8s_statefulsets,
            commands::k8s_replicasets,
            commands::k8s_scale_statefulset,
            commands::k8s_restart_statefulset,
            commands::k8s_delete_daemonset,
            commands::k8s_delete_statefulset,
            commands::k8s_delete_replicaset,
            commands::k8s_jobs,
            commands::k8s_cronjobs,
            commands::k8s_trigger_cronjob,
            commands::k8s_delete_job,
            commands::k8s_delete_cronjob,
            commands::k8s_suspend_cronjob,
            commands::k8s_hpas,
            commands::k8s_create_hpa,
            commands::k8s_delete_hpa,
            commands::k8s_network_policies,
            commands::k8s_delete_network_policy,
            commands::k8s_storage_classes,
            commands::k8s_crds,
            commands::k8s_helm_list,
            commands::k8s_helm_uninstall,
            commands::k8s_helm_available,
            commands::k8s_helm_install,
            commands::k8s_port_forward,
            commands::k8s_stop_port_forward,
            commands::k8s_list_port_forwards,
            commands::system_health,
            commands::env_status,
            commands::env_fix,
            commands::env_fix_stream,
            commands::list_templates,
            commands::deploy_template,
            commands::save_user_template,
            commands::delete_user_template,
            commands::ai_ask,
            commands::get_general_settings,
            commands::save_general_settings,
            commands::save_ai_settings,
            commands::get_ai_settings,
            commands::list_ai_models,
            commands::start_daemon,
            commands::stop_daemon,
            commands::get_daemon_info,
            commands::check_for_updates,
            commands::get_api_token,
            commands::write_temp_file,
            commands::open_file_in_browser,
            commands::cleanup,
            commands::reconnect_runtime,
            commands::get_wsl_config,
            commands::save_wsl_config,
            commands::get_lima_settings,
            commands::save_lima_settings,
            commands::read_file,
            commands::save_compose_file,
            commands::check_ports,
            commands::list_remote_hosts,
            commands::add_remote_host,
            commands::update_remote_host,
            commands::remove_remote_host,
            commands::switch_host,
            commands::get_active_host,
            commands::test_remote_host,
        ])
        .setup(move |app| {
            tray::setup_tray(app.handle())?;

            // macOS: native rounded corners
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(move |webview| {
                        use cocoa::appkit::{NSWindow, NSWindowStyleMask, NSWindowTitleVisibility};
                        use cocoa::base::{id, YES, NO};
                        unsafe {
                            let ns_window: id = webview.ns_window() as id;
                            // Re-add titled mask for native rounded corners + traffic light buttons
                            let mut mask = ns_window.styleMask();
                            mask |= NSWindowStyleMask::NSFullSizeContentViewWindowMask;
                            mask |= NSWindowStyleMask::NSTitledWindowMask;
                            mask |= NSWindowStyleMask::NSClosableWindowMask;
                            mask |= NSWindowStyleMask::NSMiniaturizableWindowMask;
                            mask |= NSWindowStyleMask::NSResizableWindowMask;
                            ns_window.setStyleMask_(mask);
                            // Hide the titlebar visually
                            ns_window.setTitlebarAppearsTransparent_(YES);
                            ns_window.setTitleVisibility_(NSWindowTitleVisibility::NSWindowTitleHidden);
                            ns_window.setHasShadow_(YES);
                            ns_window.setOpaque_(NO);
                        }
                    });
                }
            }

            // Auto-start daemon in background
            let dm_setup = dm.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = dm_setup.start().await {
                    tracing::warn!("Failed to auto-start daemon: {e}");
                }
            });

            // Check for updates in background
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                use tauri_plugin_updater::UpdaterExt;
                match app_handle.updater() {
                    Ok(updater) => match updater.check().await {
                        Ok(Some(update)) => {
                            tracing::info!("Update available: v{}", update.version);
                        }
                        Ok(None) => {
                            tracing::debug!("No updates available");
                        }
                        Err(e) => {
                            tracing::debug!("Update check failed: {e}");
                        }
                    },
                    Err(e) => {
                        tracing::debug!("Updater not available: {e}");
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|_window, _event| {
            // On macOS, hide the window instead of quitting when closed
            // (the app lives in the menu bar)
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                if _window.label() == "main" {
                    api.prevent_close();
                    let _ = _window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running orca");
}
