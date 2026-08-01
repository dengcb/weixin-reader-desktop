use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    App, AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

use crate::plugin_manager;
use crate::settings;

/// Chrome 风格的缩放级别
const ZOOM_LEVELS: [f64; 11] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

/// 从设置文件读取当前站点的 zoom 值（zoom 按站点独立存储）
fn get_current_zoom<R: Runtime>(app: &AppHandle<R>, site_id: &str) -> f64 {
    let s = settings::read_settings(app).unwrap_or_else(|_| settings::default_settings());
    s.get("sites")
        .and_then(|sites| sites.get(site_id))
        .and_then(|site| site.get("zoom"))
        .and_then(|z| z.as_f64())
        .unwrap_or(0.75)
}

/// 保存 zoom 值到设置文件（按站点存储）
fn save_zoom<R: Runtime>(app: &AppHandle<R>, site_id: &str, zoom: f64) {
    let path = format!("sites.{}.zoom", site_id);
    let _ = settings::update_setting(app, &path, serde_json::json!(zoom));
    // 通知前端更新 UI
    let _ = app.emit("menu-action", "zoom_changed");
}

/// 计算下一个缩放级别
fn next_zoom_level(current: f64, zoom_in: bool) -> f64 {
    if zoom_in {
        for &level in &ZOOM_LEVELS {
            if level > current {
                return level;
            }
        }
        *ZOOM_LEVELS.last().unwrap()
    } else {
        for &level in ZOOM_LEVELS.iter().rev() {
            if level < current {
                return level;
            }
        }
        *ZOOM_LEVELS.first().unwrap()
    }
}

/// 插件网站菜单项信息
struct PluginSiteMenuItem {
    id: String,
    name: String,
    #[allow(dead_code)]
    url: String,
}

/// 站点能力（控制菜单项灰掉/可用）
struct SiteCapabilities {
    wide_mode: bool,
    hide_toolbar: bool,
    hide_navbar: bool,
}

impl SiteCapabilities {
    /// 微信读书是根站点，全部可用
    fn all_enabled() -> Self {
        Self {
            wide_mode: true,
            hide_toolbar: true,
            hide_navbar: true,
        }
    }
}

/// 获取指定站点的 capabilities。
/// 微信读书（weread）返回全 true；外部插件从 manifest 读取。
fn get_site_capabilities<R: Runtime>(app: &AppHandle<R>, site_id: &str) -> SiteCapabilities {
    if site_id == "weread" {
        return SiteCapabilities::all_enabled();
    }

    if let Ok(plugins) = plugin_manager::get_installed_plugins(app) {
        for plugin in plugins {
            if plugin.id == site_id {
                if let Some(ref caps) = plugin.capabilities {
                    return SiteCapabilities {
                        wide_mode: caps.get("wideMode").and_then(|v| v.as_bool()).unwrap_or(false),
                        hide_toolbar: caps.get("hideToolbar").and_then(|v| v.as_bool()).unwrap_or(false),
                        hide_navbar: caps.get("hideNavbar").and_then(|v| v.as_bool()).unwrap_or(false),
                    };
                }
            }
        }
    }

    SiteCapabilities {
        wide_mode: false,
        hide_toolbar: false,
        hide_navbar: false,
    }
}

/// 遍历菜单树，按 capabilities 设置 reader_wide / hide_toolbar / hide_navbar 的 enabled。
fn apply_capability_to_menu<R: Runtime>(app: &AppHandle<R>, caps: &SiteCapabilities) {
    let Some(menu) = app.menu() else { return };
    let Ok(top_items) = menu.items() else { return };

    for top in top_items.iter() {
        let Some(submenu) = top.as_submenu() else { continue };
        let is_view = submenu.text().ok().map(|t| t == "视图").unwrap_or(false);
        if !is_view { continue }
        let Ok(sub_items) = submenu.items() else { continue };
        for item in sub_items.iter() {
            let id = item.id().as_ref();
            if let Some(check_item) = item.as_check_menuitem() {
                match id {
                    "reader_wide" => { let _ = check_item.set_enabled(caps.wide_mode); }
                    "hide_toolbar" => { let _ = check_item.set_enabled(caps.hide_toolbar); }
                    "hide_navbar" => { let _ = check_item.set_enabled(caps.hide_navbar); }
                    _ => {}
                }
            }
        }
    }
}

/// 动态显示/隐藏编辑菜单
/// macOS 不支持隐藏 Submenu，只能 remove/insert
/// 这里用 remove_at + 重建的方式实现
pub fn set_edit_menu_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    let Some(menu) = app.menu() else { return };
    let Ok(top_items) = menu.items() else { return };

    // 查找编辑菜单的位置
    let mut edit_index: Option<usize> = None;
    for (i, top) in top_items.iter().enumerate() {
        let Some(submenu) = top.as_submenu() else { continue };
        if submenu.text().unwrap_or_default() == "编辑" {
            edit_index = Some(i);
            break;
        }
    }

    match (visible, edit_index) {
        (false, Some(i)) => {
            // 隐藏：从菜单移除
            let _ = menu.remove_at(i);
        }
        (true, None) => {
            // 显示：重新创建并插入到 app_menu 之后（index=1）
            let edit_menu = match Submenu::with_items(app, "编辑", true, &[
                &PredefinedMenuItem::undo(app, Some("撤销")).unwrap(),
                &PredefinedMenuItem::redo(app, Some("重做")).unwrap(),
                &PredefinedMenuItem::separator(app).unwrap(),
                &PredefinedMenuItem::cut(app, Some("剪切")).unwrap(),
                &PredefinedMenuItem::copy(app, Some("拷贝")).unwrap(),
                &PredefinedMenuItem::paste(app, Some("粘贴")).unwrap(),
                &PredefinedMenuItem::select_all(app, Some("全选")).unwrap(),
            ]) {
                Ok(m) => m,
                Err(_) => return,
            };
            let _ = menu.insert(&edit_menu, 1);
        }
        _ => {} // 状态已正确，无需操作
    }
}

/// 获取已安装插件的网站菜单项
fn get_plugin_site_items<R: Runtime>(handle: &tauri::AppHandle<R>) -> Vec<PluginSiteMenuItem> {
    let mut items = Vec::new();

    // 获取外部插件
    if let Ok(plugins) = plugin_manager::get_installed_plugins(handle) {
        for plugin in plugins {
            if let Some(site) = plugin.site {
                items.push(PluginSiteMenuItem {
                    id: format!("switch_site_{}", plugin.id),
                    name: format!("{}", plugin.name),
                    url: site.home_url,
                });
            }
        }
    }

    items
}

/// 构建「书店」子菜单
/// 仅当存在至少一个外部插件站点时返回 Some;只有微信读书时返回 None(不挂菜单)
/// 子项:微信读书(switch_site_weread) + 每个外部插件站点(switch_site_<pluginId>)
/// 使用 CheckMenuItem，当前站点(current_site_id)前面显示对勾
fn build_bookstore_menu<R: Runtime, M: tauri::Manager<R>>(
    manager: &M,
    plugin_sites: &[PluginSiteMenuItem],
    current_site_id: &str,
) -> tauri::Result<Option<Submenu<R>>> {
    println!(
        "[Bookstore] build_bookstore_menu: current_site_id={}, plugin_sites={}",
        current_site_id,
        plugin_sites.len()
    );
    if plugin_sites.is_empty() {
        return Ok(None);
    }
    let weread_item = CheckMenuItem::with_id(
        manager,
        "switch_site_weread",
        "微信读书",
        true,
        current_site_id == "weread",
        None::<&str>,
    )?;
    let menu = Submenu::with_items(manager, "书店", true, &[&weread_item])?;
    let target_id = format!("switch_site_{}", current_site_id);
    for site in plugin_sites {
        // site.id 形如 switch_site_<pluginId>
        let item = CheckMenuItem::with_id(
            manager,
            &site.id,
            &site.name,
            true,
            site.id == target_id,
            None::<&str>,
        )?;
        menu.append(&item)?;
    }
    Ok(Some(menu))
}

/// 读取当前活跃站点 id（供书店菜单初始对勾），来自 settings.global.lastSiteId
fn current_site_id<R: Runtime>(handle: &tauri::AppHandle<R>) -> String {
    crate::settings::read_settings(handle)
        .unwrap_or_else(|_| crate::settings::default_settings())
        .get("global")
        .and_then(|g| g.get("lastSiteId"))
        .and_then(|v| v.as_str())
        .unwrap_or("weread")
        .to_string()
}

// Re-export monitor module functions for convenience
#[cfg(target_os = "macos")]
use crate::monitor::{
    calculate_center_position, get_current_monitor_index as get_current_screen_index,
    get_macos_display_names, start_position_monitoring,
};

#[cfg(target_os = "windows")]
use crate::monitor::{
    calculate_center_position, get_current_monitor_index as get_current_screen_index,
    get_display_names, start_position_monitoring,
};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use crate::monitor::{
    calculate_center_position, get_current_monitor_index as get_current_screen_index,
    get_display_names,
};

/// Build menu items for available monitors (excluding current)
/// Returns a vector of menu items that can be added directly to the window menu
fn build_monitor_menu_items<R: Runtime>(
    handle: &tauri::AppHandle<R>,
) -> tauri::Result<Vec<MenuItem<R>>> {
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

            eprintln!(
                "DEBUG: Display[{}] should_skip={} (current_screen_index={:?})",
                index, should_skip, current_screen_index
            );

            if should_skip {
                continue; // Skip current monitor
            }

            // Get display name or fall back to generic name
            let name_str: String = display_names
                .get(index)
                .cloned()
                .unwrap_or_else(|| format!("显示器 {}", index + 1));

            // Create menu item with ID like "move_to_monitor_0"
            let item_id = format!("move_to_monitor_{}", index);
            // Use Chinese double quotes: "..."
            let left_quote = "\u{201C}"; // "
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
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn rebuild_full_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<()> {
    eprintln!("DEBUG: Rebuilding menu after window move...");

    // Load current settings
    let initial_settings = get_initial_settings(handle);

    // Common menu items
    let about = MenuItem::with_id(handle, "about", "关于", true, None::<&str>)?;
    let check_update =
        MenuItem::with_id(handle, "check_update", "检查更新...", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "设置...", true, Some("CmdOrCtrl+,"))?;
    let quit = PredefinedMenuItem::quit(handle, Some("退出"))?;

    // macOS-only: App Menu with hide/show items
    #[cfg(target_os = "macos")]
    let app_menu = {
        let hide = PredefinedMenuItem::hide(handle, Some("隐藏"))?;
        let hide_others = PredefinedMenuItem::hide_others(handle, Some("隐藏其他"))?;
        let show_all = PredefinedMenuItem::show_all(handle, Some("显示全部"))?;

        Submenu::with_items(
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
        )?
    };

    // Windows: File Menu (settings, quit)
    #[cfg(target_os = "windows")]
    let file_menu = Submenu::with_items(
        handle,
        "文件",
        true,
        &[&settings, &PredefinedMenuItem::separator(handle)?, &quit],
    )?;

    // View Menu (same for all platforms)
    let refresh = MenuItem::with_id(handle, "refresh", "刷新", true, Some("CmdOrCtrl+R"))?;
    let back = MenuItem::with_id(handle, "back", "后退", true, Some("CmdOrCtrl+["))?;
    let forward = MenuItem::with_id(handle, "forward", "前进", true, Some("CmdOrCtrl+]"))?;

    let auto_flip = CheckMenuItem::with_id(
        handle,
        "auto_flip",
        "自动翻页",
        true,
        initial_settings.auto_flip_active,
        Some("CmdOrCtrl+I"),
    )?;
    let zoom_reset =
        MenuItem::with_id(handle, "zoom_reset", "实际大小", true, Some("CmdOrCtrl+0"))?;
    let zoom_in = MenuItem::with_id(handle, "zoom_in", "放大", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(handle, "zoom_out", "缩小", true, Some("CmdOrCtrl+-"))?;

    // Windows: Use F11 for fullscreen toggle
    #[cfg(target_os = "windows")]
    let toggle_fullscreen =
        MenuItem::with_id(handle, "toggle_fullscreen", "切换全屏", true, Some("F11"))?;
    #[cfg(target_os = "macos")]
    let toggle_fullscreen = PredefinedMenuItem::fullscreen(handle, Some("切换全屏"))?;

    let reader_wide = CheckMenuItem::with_id(
        handle,
        "reader_wide",
        "阅读变宽",
        true,
        initial_settings.reader_wide,
        Some("CmdOrCtrl+9"),
    )?;
    let hide_cursor = CheckMenuItem::with_id(
        handle,
        "hide_cursor",
        "隐藏光标",
        true,
        initial_settings.hide_cursor,
        Some("CmdOrCtrl+8"),
    )?;
    let hide_toolbar = CheckMenuItem::with_id(
        handle,
        "hide_toolbar",
        "隐藏工具栏",
        true,
        initial_settings.hide_toolbar,
        Some("CmdOrCtrl+O"),
    )?;
    let hide_navbar = CheckMenuItem::with_id(
        handle,
        "hide_navbar",
        "隐藏导航栏",
        true,
        initial_settings.hide_navbar,
        Some("CmdOrCtrl+P"),
    )?;

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
            &hide_cursor,
            &hide_toolbar,
            &hide_navbar,
        ],
    )?;

    // Window Menu - Rebuild monitor items
    let monitor_items = build_monitor_menu_items(handle)?;
    let minimize = PredefinedMenuItem::minimize(handle, Some("最小化"))?;
    let close_window = PredefinedMenuItem::close_window(handle, Some("关闭"))?;

    let window_menu = Submenu::with_items(
        handle,
        "窗口",
        true,
        &[&minimize, &PredefinedMenuItem::separator(handle)?],
    )?;

    for item in &monitor_items {
        window_menu.append(item)?;
    }
    window_menu.append(&close_window)?;

    // 书店菜单（仅当存在外部插件站点时出现）
    let plugin_sites = get_plugin_site_items(handle);
    let bookstore_menu = build_bookstore_menu(handle, &plugin_sites, &current_site_id(handle))?;

    // Windows: Help menu = About + Check Update（站点切换已移至「书店」菜单）
    #[cfg(target_os = "windows")]
    let help_menu = Submenu::with_items(handle, "帮助", true, &[&check_update, &about])?;

    // Build final menu based on platform
    #[cfg(target_os = "macos")]
    let menu = {
        let mut items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
            vec![&app_menu, &view_menu, &window_menu];
        if let Some(ref bs) = bookstore_menu {
            items.push(bs);
        }
        Menu::with_items(handle, &items)?
    };

    #[cfg(target_os = "windows")]
    let menu = {
        let mut items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
            vec![&file_menu, &view_menu, &window_menu];
        if let Some(ref bs) = bookstore_menu {
            items.push(bs);
        }
        items.push(&help_menu);
        Menu::with_items(handle, &items)?
    };

    handle.set_menu(menu)?;

    // 按当前站点 capabilities 灰掉不适用的菜单项
    let caps = get_site_capabilities(handle, &current_site_id(handle));
    apply_capability_to_menu(handle, &caps);

    eprintln!("DEBUG: Menu rebuilt successfully");

    if let Some(main_window) = handle.get_webview_window("main") {
        let _ = main_window.emit("menu-rebuilt", ());
        eprintln!("DEBUG: Emitted menu-rebuilt event to frontend");
    }

    Ok(())
}

pub fn init<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    let handle = app.handle();

    // Start window position monitoring (macOS and Windows)
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let handle_clone = handle.clone();
        start_position_monitoring(handle_clone.clone(), move |h| rebuild_full_menu(h));
    }

    // Load initial settings to set menu states correctly
    let initial_settings = get_initial_settings(handle);

    // Common menu items
    let about = MenuItem::with_id(handle, "about", "关于", true, None::<&str>)?;
    let check_update =
        MenuItem::with_id(handle, "check_update", "检查更新...", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "设置...", true, Some("CmdOrCtrl+,"))?;
    let quit = PredefinedMenuItem::quit(handle, Some("退出"))?;

    // macOS: App Menu with hide/show items
    #[cfg(target_os = "macos")]
    let app_menu = {
        let hide = PredefinedMenuItem::hide(handle, Some("隐藏"))?;
        let hide_others = PredefinedMenuItem::hide_others(handle, Some("隐藏其他"))?;
        let show_all = PredefinedMenuItem::show_all(handle, Some("显示全部"))?;

        Submenu::with_items(
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
        )?
    };

    // Windows: File Menu
    #[cfg(target_os = "windows")]
    let file_menu = Submenu::with_items(
        handle,
        "文件",
        true,
        &[&settings, &PredefinedMenuItem::separator(handle)?, &quit],
    )?;

    // Manage menu state for updates
    app.manage(crate::update::MenuState {
        check_update_item: std::sync::Mutex::new(Some(check_update.clone())),
    });

    // View Menu
    let refresh = MenuItem::with_id(handle, "refresh", "刷新", true, Some("CmdOrCtrl+R"))?;
    let back = MenuItem::with_id(handle, "back", "后退", true, Some("CmdOrCtrl+["))?;
    let forward = MenuItem::with_id(handle, "forward", "前进", true, Some("CmdOrCtrl+]"))?;

    let auto_flip_initial = initial_settings.auto_flip_active;
    let auto_flip = CheckMenuItem::with_id(
        handle,
        "auto_flip",
        "自动翻页",
        true,
        auto_flip_initial,
        Some("CmdOrCtrl+I"),
    )?;

    let zoom_reset =
        MenuItem::with_id(handle, "zoom_reset", "实际大小", true, Some("CmdOrCtrl+0"))?;
    let zoom_in = MenuItem::with_id(handle, "zoom_in", "放大", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(handle, "zoom_out", "缩小", true, Some("CmdOrCtrl+-"))?;

    // Fullscreen: macOS uses native, Windows uses F11
    #[cfg(target_os = "macos")]
    let toggle_fullscreen = PredefinedMenuItem::fullscreen(handle, Some("切换全屏"))?;
    #[cfg(target_os = "windows")]
    let toggle_fullscreen =
        MenuItem::with_id(handle, "toggle_fullscreen", "切换全屏", true, Some("F11"))?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let toggle_fullscreen =
        MenuItem::with_id(handle, "toggle_fullscreen", "切换全屏", true, Some("F11"))?;

    let reader_wide_initial = initial_settings.reader_wide;
    let hide_cursor_initial = initial_settings.hide_cursor;
    let hide_toolbar_initial = initial_settings.hide_toolbar;
    let hide_navbar_initial = initial_settings.hide_navbar;
    let reader_wide = CheckMenuItem::with_id(
        handle,
        "reader_wide",
        "阅读变宽",
        true,
        reader_wide_initial,
        Some("CmdOrCtrl+9"),
    )?;
    let hide_cursor = CheckMenuItem::with_id(
        handle,
        "hide_cursor",
        "隐藏光标",
        true,
        hide_cursor_initial,
        Some("CmdOrCtrl+8"),
    )?;
    let hide_toolbar = CheckMenuItem::with_id(
        handle,
        "hide_toolbar",
        "隐藏工具栏",
        true,
        hide_toolbar_initial,
        Some("CmdOrCtrl+O"),
    )?;
    let hide_navbar = CheckMenuItem::with_id(
        handle,
        "hide_navbar",
        "隐藏导航栏",
        true,
        hide_navbar_initial,
        Some("CmdOrCtrl+P"),
    )?;

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
            &hide_cursor,
            &hide_toolbar,
            &hide_navbar,
        ],
    )?;

    // Window Menu
    let monitor_items = build_monitor_menu_items(handle)?;
    let minimize = PredefinedMenuItem::minimize(handle, Some("最小化"))?;
    let close_window = PredefinedMenuItem::close_window(handle, Some("关闭"))?;

    let window_menu = Submenu::with_items(
        handle,
        "窗口",
        true,
        &[&minimize, &PredefinedMenuItem::separator(handle)?],
    )?;

    for item in &monitor_items {
        window_menu.append(item)?;
    }
    window_menu.append(&close_window)?;

    // 书店菜单（仅当存在外部插件站点时出现）
    let plugin_sites = get_plugin_site_items(handle);
    let bookstore_menu = build_bookstore_menu(handle, &plugin_sites, &current_site_id(handle))?;

    // Windows/Linux: Help menu = About + Check Update（站点切换已移至「书店」菜单）
    #[cfg(not(target_os = "macos"))]
    let help_menu = Submenu::with_items(handle, "帮助", true, &[&check_update, &about])?;

    // Build final menu based on platform
    #[cfg(target_os = "macos")]
    let menu = {
        let mut items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
            vec![&app_menu, &view_menu, &window_menu];
        if let Some(ref bs) = bookstore_menu {
            items.push(bs);
        }
        Menu::with_items(handle, &items)?
    };

    #[cfg(target_os = "windows")]
    let menu = {
        let mut items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
            vec![&file_menu, &view_menu, &window_menu];
        if let Some(ref bs) = bookstore_menu {
            items.push(bs);
        }
        items.push(&help_menu);
        Menu::with_items(handle, &items)?
    };

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let menu = {
        // For other platforms (Linux), use File menu structure similar to Windows
        let file_menu = Submenu::with_items(
            handle,
            "文件",
            true,
            &[&settings, &PredefinedMenuItem::separator(handle)?, &quit],
        )?;
        let mut items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
            vec![&file_menu, &view_menu, &window_menu];
        if let Some(ref bs) = bookstore_menu {
            items.push(bs);
        }
        items.push(&help_menu);
        Menu::with_items(handle, &items)?
    };

    app.set_menu(menu)?;

    // 按当前站点 capabilities 灰掉不适用的菜单项
    let caps = get_site_capabilities(handle, &current_site_id(handle));
    apply_capability_to_menu(handle, &caps);

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
            "reader_wide" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "reader_wide");
                }
            }
            "hide_cursor" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "hide_cursor");
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
                    let site_id = current_site_id(&app);
                    let current = get_current_zoom(&app, &site_id);
                    let next = next_zoom_level(current, true);
                    let _ = win.set_zoom(next);
                    save_zoom(&app, &site_id, next);
                    let pct = (next * 100.0).round() as i32;
                    let _ = win.emit("show-toast", format!("{}%", pct));
                }
            }
            "zoom_out" => {
                if let Some(win) = app.get_webview_window("main") {
                    let site_id = current_site_id(&app);
                    let current = get_current_zoom(&app, &site_id);
                    let next = next_zoom_level(current, false);
                    let _ = win.set_zoom(next);
                    save_zoom(&app, &site_id, next);
                    let pct = (next * 100.0).round() as i32;
                    let _ = win.emit("show-toast", format!("{}%", pct));
                }
            }
            "zoom_reset" => {
                if let Some(win) = app.get_webview_window("main") {
                    let site_id = current_site_id(&app);
                    let _ = win.set_zoom(1.0);
                    save_zoom(&app, &site_id, 1.0);
                    let _ = win.emit("show-toast", "100%");
                }
            }
            "toggle_fullscreen" => {
                // Windows/Linux: Toggle fullscreen manually
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(is_fullscreen) = win.is_fullscreen() {
                        let _ = win.set_fullscreen(!is_fullscreen);
                    }
                }
            }
            "about" => {
                // Open settings window and navigate to about section
                if let Some(win) = app.get_webview_window("settings") {
                    let _ = win.set_focus();
                    let _ = win.eval("window.navigateToSection && window.navigateToSection('about')");
                } else {
                     let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html?tab=about".into()))
                        .title("设置")
                        .inner_size(720.0, 600.0)
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
                    // Open settings window and navigate to about section
                    if let Some(win) = app.get_webview_window("settings") {
                        let _ = win.set_focus();
                        let _ = win.eval("window.navigateToSection && window.navigateToSection('about'); window.triggerUpdateCheck && window.triggerUpdateCheck()");
                    } else {
                        let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html?tab=about&action=check_update".into()))
                            .title("设置")
                            .inner_size(720.0, 600.0)
                            .center()
                            .resizable(false)
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
                        .inner_size(720.0, 600.0)
                        .center()
                        .resizable(false)
                        .build();
                }
            }
            "quit" => {
                // Clear autoFlip.active before quitting
                let settings = crate::settings::read_settings(&handle_for_events)
                    .unwrap_or_else(|_| crate::settings::default_settings());
                if let Some(auto_flip) = settings.get("global").and_then(|g| g.get("autoFlip")).and_then(|v| v.as_object()) {
                    if auto_flip.get("active").and_then(|a| a.as_bool()).unwrap_or(false) {
                        let _ = crate::settings::update_setting(
                            &handle_for_events,
                            "global.autoFlip.active",
                            serde_json::json!(false)
                        );
                    }
                }
                std::process::exit(0);
            }
            _ => {
                // 书店站点切换：站内导航主 webview
                // 手动切换始终续读该站点上次阅读页（不受「记住书店」开关限制）；
                // 不在此写 settings，lastSiteId 由前端单写，避免双写互盖
                if id.starts_with("switch_site_") {
                    if let Some(site_id) = id.strip_prefix("switch_site_") {
                        // 判断是否点击的就是当前站点
                        let current = current_site_id(app);
                        let is_same_site = site_id == current;

                        // Rust 端直接写入 lastSiteId
                    let _ = crate::settings::update_setting(
                            &app,
                            "global.lastSiteId",
                            serde_json::json!(site_id)
                        );

                        // 立即更新书店菜单对勾（遍历菜单项，只勾选目标站点）
                        let target = tauri::menu::MenuId::from(format!("switch_site_{}", site_id).as_str());
                        if let Some(menu) = app.menu() {
                            if let Ok(items) = menu.items() {
                                for top in items.iter() {
                                    if let Some(submenu) = top.as_submenu() {
                                        if submenu.text().map(|t| t == "书店").unwrap_or(false) {
                                            if let Ok(sub_items) = submenu.items() {
                                                for it in sub_items.iter() {
                                                    if let Some(check) = it.as_check_menuitem() {
                                                        let _ = check.set_checked(*it.id() == target);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // 按目标站点 capabilities 灰掉不适用的菜单项
                        let caps = get_site_capabilities(app, site_id);
                        apply_capability_to_menu(app, &caps);

                        // 如果点击的就是当前站点，只更新对勾和 capabilities，不导航
                        if is_same_site {
                            return;
                        }

                        let settings = crate::settings::read_settings(app)
                            .unwrap_or_else(|_| crate::settings::default_settings());
                        // 与启动逻辑一致：受 global.lastPage 开关控制
                        // 开 → 跳上次阅读页；关 → 跳站点首页
                        let remember_page = settings.get("global")
                            .and_then(|g| g.get("lastPage"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true);
                        let target = if remember_page {
                            settings.get("sites")
                                .and_then(|s| s.get(site_id))
                                .and_then(|s| s.get("lastReaderUrl"))
                                .and_then(|u| u.as_str())
                                .map(|s| s.to_string())
                                .or_else(|| crate::sites::resolve_home_url(app, site_id))
                        } else {
                            crate::sites::resolve_home_url(app, site_id)
                        };
                        if let Some(url) = target {
                            if let Some(win) = app.get_webview_window("main") {
                                // 只导航，zoom 由前端注入脚本在新页面初始化时设置
                                match url.parse::<tauri::Url>() {
                                    Ok(u) => { let _ = win.navigate(u); }
                                    Err(e) => eprintln!("[Bookstore] Invalid URL '{}': {:?}", url, e),
                                }
                            }
                        }
                    }
                    return;
                }

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
#[derive(Debug, PartialEq)]
struct InitialSettings {
    reader_wide: bool,
    hide_toolbar: bool,
    hide_navbar: bool,
    auto_flip_active: bool,
    hide_cursor: bool,
}

fn initial_settings_from_document(document: &serde_json::Value) -> InitialSettings {
    let global = document
        .get("global")
        .and_then(serde_json::Value::as_object);
    let site_id = global
        .and_then(|value| value.get("lastSiteId"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("weread");
    let site = document
        .get("sites")
        .and_then(|value| value.get(site_id))
        .and_then(serde_json::Value::as_object);

    InitialSettings {
        reader_wide: site
            .and_then(|value| value.get("readerWide"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        hide_toolbar: site
            .and_then(|value| value.get("hideToolbar"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        hide_navbar: site
            .and_then(|value| value.get("hideNavbar"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        auto_flip_active: global
            .and_then(|value| value.get("autoFlip"))
            .and_then(serde_json::Value::as_object)
            .and_then(|value| value.get("active"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        hide_cursor: global
            .and_then(|value| value.get("hideCursor"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    }
}

// Load initial settings from the settings file (same path as settings.rs)
fn get_initial_settings<R: Runtime>(handle: &tauri::AppHandle<R>) -> InitialSettings {
    // Use the same path as settings.rs: app_config_dir() + "settings.json"
    let settings_path = handle
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("settings.json")).ok());

    if let Some(settings_str) = settings_path {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&settings_str) {
            return initial_settings_from_document(&json);
        }
    }

    // Default values if settings file doesn't exist or can't be read
    InitialSettings {
        reader_wide: false,
        hide_toolbar: false,
        hide_navbar: false,
        auto_flip_active: false,
        hide_cursor: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn zoom_levels_move_to_the_nearest_supported_neighbor_and_clamp() {
        assert_eq!(next_zoom_level(0.75, true), 0.8);
        assert_eq!(next_zoom_level(0.75, false), 0.67);
        assert_eq!(next_zoom_level(0.1, false), 0.5);
        assert_eq!(next_zoom_level(0.1, true), 0.5);
        assert_eq!(next_zoom_level(3.0, true), 2.0);
        assert_eq!(next_zoom_level(3.0, false), 2.0);
        assert_eq!(next_zoom_level(0.750_000_1, true), 0.8);
        assert_eq!(next_zoom_level(0.749_999_9, false), 0.67);
    }

    #[test]
    fn initial_menu_state_reads_global_and_active_site_from_schema_v2() {
        let document = json!({
            "schemaVersion": 2,
            "_version": 3,
            "global": {
                "lastSiteId": "fanqie",
                "hideCursor": true,
                "autoFlip": { "active": true, "interval": 20, "keepAwake": false }
            },
            "sites": {
                "weread": { "readerWide": false, "hideToolbar": false },
                "fanqie": {
                    "readerWide": true,
                    "hideToolbar": true,
                    "hideNavbar": true
                }
            },
            "pluginConfigs": {}
        });

        assert_eq!(
            initial_settings_from_document(&document),
            InitialSettings {
                reader_wide: true,
                hide_toolbar: true,
                hide_navbar: true,
                auto_flip_active: true,
                hide_cursor: true,
            }
        );
    }

    #[test]
    fn initial_menu_state_defaults_missing_or_mistyped_values() {
        assert_eq!(
            initial_settings_from_document(&json!({})),
            InitialSettings {
                reader_wide: false,
                hide_toolbar: false,
                hide_navbar: false,
                auto_flip_active: false,
                hide_cursor: false,
            }
        );
        assert_eq!(
            initial_settings_from_document(&json!({
                "global": { "lastSiteId": 7, "hideCursor": "yes" },
                "sites": { "weread": { "readerWide": "yes" } }
            })),
            InitialSettings {
                reader_wide: false,
                hide_toolbar: false,
                hide_navbar: false,
                auto_flip_active: false,
                hide_cursor: false,
            }
        );
    }

    #[test]
    fn bookstore_menu_is_absent_without_external_sites() {
        let app = tauri::test::mock_app();
        let menu = build_bookstore_menu(app.handle(), &[], "weread").unwrap();
        assert!(menu.is_none());
    }
}
