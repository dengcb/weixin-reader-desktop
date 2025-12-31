use tauri::{AppHandle, Manager, WebviewWindow};
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};

// Lazy static to store the current log file paths
// Using Mutex to safely access from multiple threads
static CURRENT_FRONTEND_LOG: Mutex<Option<String>> = Mutex::new(None);

/// Monitor information for multi-monitor support
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

#[tauri::command]
pub fn log_frontend(message: String) {
    println!("[Frontend] {}", message);
}

#[tauri::command]
pub fn log_to_file(_app: AppHandle, message: String) {
    // In dev mode, current_dir() is src-tauri, so go to parent for project root
    let project_root = std::env::current_dir()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from(".."));

    let log_dir = project_root.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);

    // Get or create log file for this session
    let log_file = {
        let mut log_guard = CURRENT_FRONTEND_LOG.lock().unwrap();
        if log_guard.is_none() {
            let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let filename = format!("frontend-{}.log", timestamp);
            let path = log_dir.join(&filename).to_string_lossy().to_string();
            *log_guard = Some(path.clone());
            path
        } else {
            log_guard.as_ref().unwrap().clone()
        }
    };

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_file) {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(file, "[{}] {}", timestamp, message);
    }
}

#[tauri::command]
pub fn update_menu_state(app: AppHandle, id: String, state: bool) {
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            // Item 1 is the View submenu
            if let Some(view_submenu) = items.get(1).and_then(|i| i.as_submenu()) {
                if let Ok(sub_items) = view_submenu.items() {
                    for sub_item in sub_items.iter() {
                        if *sub_item.id() == tauri::menu::MenuId::from(id.as_str()) {
                            if let Some(check_item) = sub_item.as_check_menuitem() {
                                let _ = check_item.set_checked(state);
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn set_menu_item_enabled(app: AppHandle, id: String, enabled: bool) {
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            // Check all menus (App menu is index 0, View is index 1, etc.)
            for menu_item in items.iter() {
                if let Some(submenu) = menu_item.as_submenu() {
                    if let Ok(sub_items) = submenu.items() {
                        for sub_item in sub_items.iter() {
                            if *sub_item.id() == tauri::menu::MenuId::from(id.as_str()) {
                                // Try to set enabled on any menu item type that supports it
                                if let Some(check_item) = sub_item.as_check_menuitem() {
                                    let _ = check_item.set_enabled(enabled);
                                } else if let Some(menu_item) = sub_item.as_menuitem() {
                                    let _ = menu_item.set_enabled(enabled);
                                } else if let Some(sub) = sub_item.as_submenu() {
                                    let _ = sub.set_enabled(enabled);
                                }
                                return;
                            }
                        }
                    }
                }
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

/// Get list of available monitors
#[tauri::command]
pub fn get_available_monitors(window: WebviewWindow) -> Result<Vec<MonitorInfo>, String> {
    let monitors = window.available_monitors()
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for monitor in monitors {
        let pos = monitor.position();
        let size = monitor.size();
        let name = monitor.name();
        let display_name = format!("Display {}", pos.x);
        let name_str = name.as_deref().unwrap_or(&display_name);
        result.push(MonitorInfo {
            name: name_str.to_string(),
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            scale_factor: monitor.scale_factor(),
        });
    }

    Ok(result)
}

/// Move window to the specified monitor
#[tauri::command]
pub fn move_window_to_monitor(window: WebviewWindow, monitor_name: String) -> Result<(), String> {
    let monitors = window.available_monitors()
        .map_err(|e| e.to_string())?;

    // Find the target monitor by name
    let target_monitor = monitors
        .iter()
        .find(|m| {
            let name = m.name();
            let pos = m.position();
            let display_name = format!("Display {}", pos.x);
            let name_str = name.as_deref().unwrap_or(&display_name);
            name_str == monitor_name.as_str()
        })
        .ok_or_else(|| format!("Monitor '{}' not found", monitor_name))?;

    // Get current window size
    let current_size = window.outer_size()
        .map_err(|e| e.to_string())?;

    // Calculate centered position on target monitor
    let pos = target_monitor.position();
    let size = target_monitor.size();
    let x = pos.x + (size.width as i32 - current_size.width as i32) / 2;
    let y = pos.y + (size.height as i32 - current_size.height as i32) / 2;

    window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x as f64, y as f64)))
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Get current monitor info
#[tauri::command]
pub fn get_current_monitor(window: WebviewWindow) -> Result<MonitorInfo, String> {
    let monitor = window.current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No current monitor found".to_string())?;

    let pos = monitor.position();
    let size = monitor.size();
    let name = monitor.name();
    let display_name = format!("Display {}", pos.x);
    let name_str = name.as_deref().unwrap_or(&display_name);
    Ok(MonitorInfo {
        name: name_str.to_string(),
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        scale_factor: monitor.scale_factor(),
    })
}

/// Navigate to URL (for restoring last page)
#[tauri::command]
pub fn navigate_to_url(window: WebviewWindow, url: String) {
    println!("[Navigate] Navigating to: {}", url);
    let _ = window.eval(&format!("window.location.href = {}", serde_json::to_string(&url).unwrap()));
}
