use tauri::{
    menu::{Menu, MenuItem, Submenu, CheckMenuItem, PredefinedMenuItem},
    App, Emitter, Manager, Runtime, WebviewWindowBuilder, WebviewUrl
};
use tauri_plugin_opener::OpenerExt;

// Re-export monitor module functions for convenience
#[cfg(target_os = "macos")]
use crate::monitor::{get_current_monitor_index as get_current_screen_index, get_macos_display_names, calculate_center_position, start_position_monitoring};

#[cfg(not(target_os = "macos"))]
use crate::monitor::{get_current_monitor_index as get_current_screen_index, get_display_names, calculate_center_position, start_position_monitoring};

/// Build menu items for available monitors (excluding current)
/// Returns a vector of menu items that can be added directly to the window menu
fn build_monitor_menu_items<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Vec<MenuItem<R>>> {
    let mut monitor_items = Vec::new();

    // Get the index of the screen that the main window is on
    let current_screen_index = get_current_screen_index(handle);

    eprintln!("DEBUG: current_screen_index: {:?}", current_screen_index);

    // Get display names based on platform
    #[cfg(target_os = "macos")]
    let display_names = get_macos_display_names();

    #[cfg(not(target_os = "macos"))]
    let display_names = get_display_names(handle);

    eprintln!("DEBUG: display_names: {:?}", display_names);

    // Use Tauri's available_monitors to get all monitors
    if let Ok(monitors) = handle.available_monitors() {
        for (index, _monitor) in monitors.iter().enumerate() {
            // Skip if this is the monitor where the main window is currently located
            let should_skip = current_screen_index == Some(index);

            eprintln!("DEBUG: Display[{}] should_skip={} (current_screen_index={:?})",
                index, should_skip, current_screen_index);

            if should_skip {
                continue; // Skip current monitor
            }

            // Get display name or fall back to generic name
            let name_str: String = display_names.get(index)
                .cloned()
                .unwrap_or_else(|| format!("显示器 {}", index + 1));

            // Create menu item with ID like "move_to_monitor_0"
            let item_id = format!("move_to_monitor_{}", index);
            // Use Chinese double quotes: "..."
            let left_quote = "\u{201C}";  // "
            let right_quote = "\u{201D}"; // "
            let item_text = format!("移到 {}{}{}", left_quote, name_str, right_quote);

            eprintln!("DEBUG: Creating menu item: {} (ID: {})", item_text, item_id);

            if let Ok(item) = MenuItem::with_id(handle, &item_id, &item_text, true, None::<&str>) {
                monitor_items.push(item);
            }
        }
    }

    Ok(monitor_items)
}

/// Rebuild the entire menu (called after window moves)
/// This recreates the menu with updated monitor items based on current window position
fn rebuild_full_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<()> {
    eprintln!("DEBUG: Rebuilding menu after window move...");

    // Load current settings
    let initial_settings = get_initial_settings(handle);

    // 1. App Menu
    let about = MenuItem::with_id(handle, "about", "关于", true, None::<&str>)?;
    let check_update = MenuItem::with_id(handle, "check_update", "检查更新...", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "设置...", true, Some("CmdOrCtrl+,"))?;

    let hide = PredefinedMenuItem::hide(handle, Some("隐藏"))?;
    let hide_others = PredefinedMenuItem::hide_others(handle, Some("隐藏其他"))?;
    let show_all = PredefinedMenuItem::show_all(handle, Some("显示全部"))?;
    let quit = PredefinedMenuItem::quit(handle, Some("退出"))?;

    let app_menu = Submenu::with_items(
        handle,
        "App",
        true,
        &[
            &about,
            &check_update,
            &PredefinedMenuItem::separator(handle)?,
            &settings,
            &PredefinedMenuItem::separator(handle)?,
            &hide,
            &hide_others,
            &show_all,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
    )?;

    // 2. View Menu
    let refresh = MenuItem::with_id(handle, "refresh", "刷新", true, Some("CmdOrCtrl+R"))?;
    let back = MenuItem::with_id(handle, "back", "后退", true, Some("CmdOrCtrl+["))?;
    let forward = MenuItem::with_id(handle, "forward", "前进", true, Some("CmdOrCtrl+]"))?;

    let auto_flip = CheckMenuItem::with_id(handle, "auto_flip", "自动翻页", true, initial_settings.auto_flip_active, Some("CmdOrCtrl+I"))?;
    let zoom_reset = MenuItem::with_id(handle, "zoom_reset", "实际大小", true, Some("CmdOrCtrl+0"))?;
    let zoom_in = MenuItem::with_id(handle, "zoom_in", "放大", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(handle, "zoom_out", "缩小", true, Some("CmdOrCtrl+-"))?;

    let toggle_fullscreen = PredefinedMenuItem::fullscreen(handle, Some("切换全屏"))?;

    let reader_wide = CheckMenuItem::with_id(handle, "reader_wide", "阅读变宽", true, initial_settings.reader_wide, Some("CmdOrCtrl+9"))?;
    let hide_toolbar = CheckMenuItem::with_id(handle, "hide_toolbar", "隐藏工具栏", true, initial_settings.hide_toolbar, Some("CmdOrCtrl+O"))?;
    // hide_navbar 始终启用，让用户可以随时点击（前端会判断是否在双栏模式）
    let hide_navbar = CheckMenuItem::with_id(handle, "hide_navbar", "隐藏导航栏", true, initial_settings.hide_navbar, Some("CmdOrCtrl+P"))?;

    let view_menu = Submenu::with_items(
        handle,
        "视图",
        true,
        &[
            &refresh,
            &back,
            &forward,
            &PredefinedMenuItem::separator(handle)?,
            &auto_flip,
            &PredefinedMenuItem::separator(handle)?,
            &zoom_reset,
            &zoom_in,
            &zoom_out,
            &PredefinedMenuItem::separator(handle)?,
            &toggle_fullscreen,
            &PredefinedMenuItem::separator(handle)?,
            &reader_wide,
            &hide_toolbar,
            &hide_navbar,
        ],
    )?;

    // 3. Window Menu - Rebuild monitor items (THIS IS THE KEY PART)
    let monitor_items = build_monitor_menu_items(handle)?;
    let minimize = PredefinedMenuItem::minimize(handle, Some("最小化"))?;
    let close_window = PredefinedMenuItem::close_window(handle, Some("关闭"))?;

    // Build window menu - use append() to dynamically add monitor items
    // This avoids Box::leak memory leak
    let window_menu = Submenu::with_items(
        handle,
        "窗口",
        true,
        &[
            &minimize,
            &PredefinedMenuItem::separator(handle)?,
        ]
    )?;

    // Dynamically append monitor items (no Box::leak needed!)
    for item in &monitor_items {
        window_menu.append(item)?;
    }

    // Append close at the end
    window_menu.append(&close_window)?;

    // 4. Help Menu
    let official_site = MenuItem::with_id(handle, "official_site", "微信读书官网", true, None::<&str>)?;
    let help_menu = Submenu::with_items(
        handle,
        "帮助",
        true,
        &[
            &official_site
        ]
    )?;

    let menu = Menu::with_items(
        handle,
        &[
            &app_menu,
            &view_menu,
            &window_menu,
            &help_menu
        ],
    )?;

    // Set the new menu
    handle.set_menu(menu)?;

    eprintln!("DEBUG: Menu rebuilt successfully");

    // Notify frontend to resync menu state
    if let Some(main_window) = handle.get_webview_window("main") {
        let _ = main_window.emit("menu-rebuilt", ());
        eprintln!("DEBUG: Emitted menu-rebuilt event to frontend");
    }

    Ok(())
}

pub fn init<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    let handle = app.handle();

    // Start window position monitoring
    #[cfg(target_os = "macos")]
    {
        let handle_clone = handle.clone();
        start_position_monitoring(handle_clone.clone(), move |h| rebuild_full_menu(h));
    }

    // Load initial settings to set menu states correctly
    let initial_settings = get_initial_settings(handle);

    // 1. App Menu (macOS only mostly)
    let about = MenuItem::with_id(handle, "about", "关于", true, None::<&str>)?;
    let check_update = MenuItem::with_id(handle, "check_update", "检查更新...", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "设置...", true, Some("CmdOrCtrl+,"))?;
    // Use PredefinedMenuItem for quit - macOS handles it specially
    let quit = PredefinedMenuItem::quit(handle, Some("退出"))?;

    let hide = PredefinedMenuItem::hide(handle, Some("隐藏"))?;
    let hide_others = PredefinedMenuItem::hide_others(handle, Some("隐藏其他"))?;
    let show_all = PredefinedMenuItem::show_all(handle, Some("显示全部"))?;

    let app_menu = Submenu::with_items(
        handle,
        "App",
        true,
        &[
            &about,
            &check_update,
            &PredefinedMenuItem::separator(handle)?,
            &settings,
            &PredefinedMenuItem::separator(handle)?,
            &hide,
            &hide_others,
            &show_all,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
    )?;

    // Manage menu state for updates
    app.manage(crate::update::MenuState {
        check_update_item: std::sync::Mutex::new(Some(check_update.clone()))
    });

    // 2. View Menu
    let refresh = MenuItem::with_id(handle, "refresh", "刷新", true, Some("CmdOrCtrl+R"))?;
    let back = MenuItem::with_id(handle, "back", "后退", true, Some("CmdOrCtrl+["))?;
    let forward = MenuItem::with_id(handle, "forward", "前进", true, Some("CmdOrCtrl+]"))?;

    // Use initial settings value for auto_flip
    let auto_flip_initial = initial_settings.auto_flip_active;
    let auto_flip = CheckMenuItem::with_id(handle, "auto_flip", "自动翻页", true, auto_flip_initial, Some("CmdOrCtrl+I"))?;

    let zoom_reset = MenuItem::with_id(handle, "zoom_reset", "实际大小", true, Some("CmdOrCtrl+0"))?;
    let zoom_in = MenuItem::with_id(handle, "zoom_in", "放大", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(handle, "zoom_out", "缩小", true, Some("CmdOrCtrl+-"))?;

    // Native macOS Fullscreen MenuItem
    let toggle_fullscreen = PredefinedMenuItem::fullscreen(handle, Some("切换全屏"))?;

    // Use initial settings values for reader_wide and hide_toolbar
    let reader_wide_initial = initial_settings.reader_wide;
    let hide_toolbar_initial = initial_settings.hide_toolbar;
    let hide_navbar_initial = initial_settings.hide_navbar;
    let reader_wide = CheckMenuItem::with_id(handle, "reader_wide", "阅读变宽", true, reader_wide_initial, Some("CmdOrCtrl+9"))?;
    let hide_toolbar = CheckMenuItem::with_id(handle, "hide_toolbar", "隐藏工具栏", true, hide_toolbar_initial, Some("CmdOrCtrl+O"))?;
    // hide_navbar 始终启用，让用户可以随时点击（前端会判断是否在双栏模式）
    let hide_navbar = CheckMenuItem::with_id(handle, "hide_navbar", "隐藏导航栏", true, hide_navbar_initial, Some("CmdOrCtrl+P"))?;

    let view_menu = Submenu::with_items(
        handle,
        "视图",
        true,
        &[
            &refresh,
            &back,
            &forward,
            &PredefinedMenuItem::separator(handle)?,
            &auto_flip,
            &PredefinedMenuItem::separator(handle)?,
            &zoom_reset,
            &zoom_in,
            &zoom_out,
            &PredefinedMenuItem::separator(handle)?,
            &toggle_fullscreen,
            &PredefinedMenuItem::separator(handle)?,
            &reader_wide,
            &hide_toolbar,
            &hide_navbar,
        ],
    )?;

    // 3. Window Menu - Build monitor items (excluding current)
    let monitor_items = build_monitor_menu_items(handle)?;
    let minimize = PredefinedMenuItem::minimize(handle, Some("最小化"))?;
    let close_window = PredefinedMenuItem::close_window(handle, Some("关闭"))?;

    // Build window menu - use append() to dynamically add monitor items
    // This avoids Box::leak memory leak
    let window_menu = Submenu::with_items(
        handle,
        "窗口",
        true,
        &[
            &minimize,
            &PredefinedMenuItem::separator(handle)?,
        ]
    )?;

    // Dynamically append monitor items (no Box::leak needed!)
    for item in &monitor_items {
        window_menu.append(item)?;
    }

    // Append close at the end
    window_menu.append(&close_window)?;

    // 4. Help Menu
    let official_site = MenuItem::with_id(handle, "official_site", "微信读书官网", true, None::<&str>)?;
    let help_menu = Submenu::with_items(
        handle,
        "帮助",
        true,
        &[
            &official_site
        ]
    )?;

    let menu = Menu::with_items(
        handle,
        &[
            &app_menu,
            &view_menu,
            &window_menu,
            &help_menu
        ],
    )?;

    app.set_menu(menu)?;

    // Event Handling - use handle for move closure
    let handle_for_events = handle.clone();
    app.on_menu_event(move |app, event| {
        let id = event.id.as_ref();
        match id {
            "refresh" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.eval("window.location.reload()");
                }
            }
            "back" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.eval("window.history.back()");
                }
            }
            "forward" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.eval("window.history.forward()");
                }
            }
            "official_site" => {
                let _ = app.opener().open_url("https://weread.qq.com/", None::<&str>);
            }
            "reader_wide" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "reader_wide");
                }
            }
            "hide_toolbar" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "hide_toolbar");
                }
            }
            "hide_navbar" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "hide_navbar");
                }
            }
            "auto_flip" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "auto_flip");
                }
            }
            "zoom_in" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "zoom_in");
                }
            }
            "zoom_out" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "zoom_out");
                }
            }
            "zoom_reset" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "zoom_reset");
                }
            }
            "about" => {
                if let Some(win) = app.get_webview_window("about") {
                    let _ = win.set_focus();
                } else {
                     let _ = WebviewWindowBuilder::new(app, "about", WebviewUrl::App("about.html".into()))
                        .title("关于")
                        .inner_size(400.0, 300.0)
                        .center()
                        .resizable(false)
                        .build();
                }
            }
            "check_update" => {
                // Check if update is downloaded and ready to install
                let mut is_downloaded = false;
                if let Some(state) = app.try_state::<crate::update::UpdateState>() {
                    if let Ok(guard) = state.downloaded.lock() {
                        is_downloaded = *guard;
                    }
                }

                if is_downloaded {
                     // Restart and install
                     app.restart();
                } else {
                    if let Some(win) = app.get_webview_window("update") {
                        let _ = win.set_focus();
                    } else {
                        let _ = WebviewWindowBuilder::new(app, "update", WebviewUrl::App("update.html".into()))
                            .title("检查更新")
                            .inner_size(400.0, 300.0)
                            .center()
                            .resizable(false)
                            .hidden_title(true)  // Hide title but keep native macOS decorations (corners, shadow)
                            .build();
                    }
                }
            }
            "settings" => {
                if let Some(win) = app.get_webview_window("settings") {
                    let _ = win.set_focus();
                } else {
                     let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
                        .title("设置")
                        .inner_size(400.0, 300.0)
                        .center()
                        .resizable(false)
                        .build();
                }
            }
            "quit" => {
                // Clear autoFlip.active before quitting
                println!("[Menu Quit] Quit requested, clearing autoFlip.active");
                let settings = crate::settings::get_settings(handle_for_events.clone());
                if let Some(auto_flip) = settings.get("autoFlip").and_then(|v| v.as_object()) {
                    if auto_flip.get("active").and_then(|a| a.as_bool()).unwrap_or(false) {
                        let update = serde_json::json!({
                            "autoFlip": {
                                "active": false,
                                "interval": auto_flip.get("interval").and_then(|i| i.as_i64()).unwrap_or(30),
                                "keepAwake": auto_flip.get("keepAwake").and_then(|k| k.as_bool()).unwrap_or(true)
                            }
                        });
                        println!("[Menu Quit] Saving updated settings: {}", serde_json::to_string(&update).unwrap_or_else(|_| "Error".to_string()));
                        crate::settings::save_settings(handle_for_events.clone(), update, None);
                        println!("[Menu Quit] Settings saved, now exiting");
                    }
                }
                // Exit the app
                std::process::exit(0);
            }
            _ => {
                // Check if this is a "move_to_monitor_*" event
                if id.starts_with("move_to_monitor_") {
                    if let Some(index_str) = id.strip_prefix("move_to_monitor_") {
                        if let Ok(index) = index_str.parse::<usize>() {
                            // First, check if window is already on the target monitor
                            let current_screen_index = get_current_screen_index(app);
                            eprintln!("DEBUG: Move request: current={:?}, target={}", current_screen_index, index);

                            // If already on target monitor, do nothing
                            if current_screen_index == Some(index) {
                                eprintln!("DEBUG: Window is already on target monitor, skipping");
                                return;
                            }

                            // Get window size and calculate center position
                            if let Some(win) = app.get_webview_window("main") {
                                if let Ok(current_size) = win.outer_size() {
                                    if let Some((x, y)) = calculate_center_position(
                                        index,
                                        (current_size.width, current_size.height),
                                        app,
                                    ) {
                                        eprintln!("DEBUG: Moving window to ({}, {}) on monitor[{}]", x, y, index);
                                        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x as f64, y as f64)));

                                        // Rebuild menu after window move
                                        // Wait a bit for the window to actually move
                                        let app_clone = app.clone();
                                        std::thread::spawn(move || {
                                            std::thread::sleep(std::time::Duration::from_millis(200));
                                            if let Err(e) = rebuild_full_menu(&app_clone) {
                                                eprintln!("DEBUG: Failed to rebuild menu: {:?}", e);
                                            }
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    Ok(())
}

// Helper struct to hold initial settings values
struct InitialSettings {
    reader_wide: bool,
    hide_toolbar: bool,
    hide_navbar: bool,
    auto_flip_active: bool,
}

// Load initial settings from the settings file (same path as settings.rs)
fn get_initial_settings<R: Runtime>(handle: &tauri::AppHandle<R>) -> InitialSettings {
    // Use the same path as settings.rs: app_config_dir() + "settings.json"
    let settings_path = handle.path().app_config_dir()
        .ok()
        .and_then(|dir| {
            std::fs::read_to_string(dir.join("settings.json")).ok()
        });

    if let Some(settings_str) = settings_path {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&settings_str) {
            let reader_wide = json.get("readerWide")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let hide_toolbar = json.get("hideToolbar")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let hide_navbar = json.get("hideNavbar")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let auto_flip_active = json.get("autoFlip")
                .and_then(|v| v.as_object())
                .and_then(|obj| obj.get("active"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            return InitialSettings {
                reader_wide,
                hide_toolbar,
                hide_navbar,
                auto_flip_active,
            };
        }
    }

    // Default values if settings file doesn't exist or can't be read
    InitialSettings {
        reader_wide: false,
        hide_toolbar: false,
        hide_navbar: false,
        auto_flip_active: false,
    }
}
