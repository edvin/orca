use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let sep_top = PredefinedMenuItem::separator(app)?;
    let show = MenuItem::with_id(app, "show", "Show Orca", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide Window", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Orca", true, None::<&str>)?;
    let sep_bottom = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&sep_top, &show, &hide, &separator, &quit, &sep_bottom])?;

    let _tray = TrayIconBuilder::new()
        .tooltip("Orca — Container Desktop")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray-32x32.png")).expect("tray icon"))
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
