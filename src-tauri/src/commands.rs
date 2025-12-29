use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
pub fn update_menu_state(app: AppHandle, id: String, state: bool) {
    if let Some(menu) = app.menu() {
        if let Some(item) = menu.get(&id) {
            if let Some(i) = item.as_check_menuitem() {
                let _ = i.set_checked(state);
            }
        }
    }
}

#[tauri::command]
pub fn set_menu_item_enabled(app: AppHandle, id: String, enabled: bool) {
    if let Some(menu) = app.menu() {
        if let Some(item) = menu.get(&id) {
            if let Some(i) = item.as_check_menuitem() {
                let _ = i.set_enabled(enabled);
            } else if let Some(i) = item.as_menuitem() {
                let _ = i.set_enabled(enabled);
            } else if let Some(i) = item.as_icon_menuitem() {
                let _ = i.set_enabled(enabled);
            } else if let Some(i) = item.as_submenu() {
                let _ = i.set_enabled(enabled);
            }
        }
    }
}

#[tauri::command]
pub fn set_zoom(app: AppHandle, value: f64) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_zoom(value);
    }
}

#[tauri::command]
pub fn close_window(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
pub fn set_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

#[tauri::command]
pub fn get_app_name(app: AppHandle) -> String {
    app.config().product_name.clone().unwrap_or("微信阅读".to_string())
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.config().version.clone().unwrap_or("0.1.0".to_string())
}
