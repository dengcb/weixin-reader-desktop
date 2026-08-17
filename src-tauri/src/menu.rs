use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    App, AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

use crate::plugin_manager;
use crate::settings;
use crate::sites;

/// macOS：退出全屏后恢复 WKWebView 键盘响应。
///
/// 编程式全屏（菜单/遥控器）退出时 NSWindow 的 firstResponder 不再是
/// WKWebView：组合键（Cmd 系）走 key equivalents 仍可触发菜单，但单键
/// （遥控器 Enter/PageUp/方向键）走 responder chain，全部丢失（NSBeep）。
///
/// DOM 元素 focus 和 set_focus（makeKeyAndOrderFront）都改不了
/// firstResponder（实证无效）。唯一有效的是 wry 内部 focus() 做的
/// `window.makeFirstResponder(wkwebview)`，但 Tauri 2.11 未暴露该 API，
/// 只能用 objc 直接调：从 contentView 子视图里找到 WKWebView 实例，
/// 调 makeFirstResponder。
///
/// 时机：退出全屏完成后（windowDidExitFullscreen 后的第二次 Resized），
/// 在 NSWindow 层直接设置，不受页面布局影响。
#[cfg(target_os = "macos")]
pub fn watch_fullscreen_exit<R: Runtime>(app: &AppHandle<R>) {
    use std::sync::atomic::{AtomicU8, Ordering};

    // 0=未全屏 1=全屏中 2=已退出全屏待聚焦
    static FS_STATE: AtomicU8 = AtomicU8::new(0);

    if let Some(win) = app.get_webview_window("main") {
        let win_clone = win.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Resized(_) = event {
                let is_fs = win_clone.is_fullscreen().unwrap_or(false);
                let prev = FS_STATE.swap(if is_fs { 1 } else { 0 }, Ordering::SeqCst);
                if !is_fs && prev == 1 {
                    // 全屏→非全屏转换：等下一次 Resized（windowDidExitFullscreen
                    // 里 tao 会 emit_resize_event）再聚焦，确保动画完全结束
                    FS_STATE.store(2, Ordering::SeqCst);
                } else if !is_fs && prev == 2 {
                    // 第二次 Resized：全屏退出流程彻底完成，恢复 first responder
                    FS_STATE.store(0, Ordering::SeqCst);
                    make_webview_first_responder(&win_clone);
                }
            }
        });
    }
}

/// 遍历 main 窗口 contentView 子视图找到 WKWebView，调 makeFirstResponder。
/// 等价于 wry WebView::focus()（Tauri 2.11 未暴露）。
#[cfg(target_os = "macos")]
fn make_webview_first_responder<R: Runtime>(win: &tauri::WebviewWindow<R>) {
    #![allow(non_camel_case_types)]
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    type id = *mut Object;

    let Ok(ns_window_ptr) = win.ns_window() else { return };
    let ns_window = ns_window_ptr as id;
    if ns_window.is_null() { return; }

    unsafe {
        let content_view: id = msg_send![ns_window, contentView];
        if content_view.is_null() { return }
        let subviews: id = msg_send![content_view, subviews];
        if subviews.is_null() { return }
        let count: usize = msg_send![subviews, count];
        let wk_class = class!(WKWebView);
        for i in 0..count {
            let view: id = msg_send![subviews, objectAtIndex: i];
            let is_wk: bool = msg_send![view, isKindOfClass: wk_class];
            if is_wk {
                let _: () = msg_send![ns_window, makeFirstResponder: view];
                return;
            }
        }
    }
}

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

/// 原生端不知道远程页面当前是否已经进入正文，因此创建、重建和跨站导航时
/// 一律先禁用阅读功能。前端 MenuManager 在确认正文路由后再读取插件能力并启用。
fn disable_reader_menu_items<R: Runtime>(app: &AppHandle<R>) {
    let Some(menu) = app.menu() else { return };
    let Ok(top_items) = menu.items() else { return };

    for top in top_items.iter() {
        let Some(submenu) = top.as_submenu() else {
            continue;
        };
        let is_view = submenu.text().ok().map(|t| t == "视图").unwrap_or(false);
        if !is_view {
            continue;
        }
        let Ok(sub_items) = submenu.items() else {
            continue;
        };
        for item in sub_items.iter() {
            let id = item.id().as_ref();
            if let Some(check_item) = item.as_check_menuitem() {
                match id {
                    "reader_wide" | "hide_cursor" | "hide_toolbar" | "hide_navbar"
                    | "auto_flip" => {
                        let _ = check_item.set_enabled(false);
                    }
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
        let Some(submenu) = top.as_submenu() else {
            continue;
        };
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
            let edit_menu = match Submenu::with_items(
                app,
                "编辑",
                true,
                &[
                    &PredefinedMenuItem::undo(app, Some("撤销")).unwrap(),
                    &PredefinedMenuItem::redo(app, Some("重做")).unwrap(),
                    &PredefinedMenuItem::separator(app).unwrap(),
                    &PredefinedMenuItem::cut(app, Some("剪切")).unwrap(),
                    &PredefinedMenuItem::copy(app, Some("拷贝")).unwrap(),
                    &PredefinedMenuItem::paste(app, Some("粘贴")).unwrap(),
                    &PredefinedMenuItem::select_all(app, Some("全选")).unwrap(),
                ],
            ) {
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
    let settings = settings::read_settings(handle).unwrap_or_else(|_| settings::default_settings());

    // 只显示当前启用的外部插件；被禁用的站点不能从菜单重新打开。
    if let Ok(plugins) = plugin_manager::get_installed_plugins(handle) {
        for plugin in plugins {
            if sites::is_site_enabled(&settings, &plugin.id) {
                if let Some(site) = plugin.site {
                    items.push(PluginSiteMenuItem {
                        id: format!("switch_site_{}", plugin.id),
                        name: plugin.name,
                        url: site.home_url,
                    });
                }
            }
        }
    }

    items
}

/// 构建「书店」子菜单。
/// 在线站点保持现有顺序；最后固定追加「自家书屋」，不把本地阅读提升为顶级入口。
/// 使用 CheckMenuItem，当前站点(current_site_id)前面显示对勾
fn build_bookstore_menu<R: Runtime>(
    manager: &tauri::AppHandle<R>,
    plugin_sites: &[PluginSiteMenuItem],
    current_site_id: &str,
    weread_enabled: bool,
) -> tauri::Result<Option<Submenu<R>>> {
    println!(
        "[Bookstore] build_bookstore_menu: current_site_id={}, plugin_sites={}",
        current_site_id,
        plugin_sites.len()
    );
    let menu = Submenu::new(manager, "书店", true)?;
    let mut online_count = 0usize;
    if weread_enabled {
        let weread_item = CheckMenuItem::with_id(
            manager,
            "switch_site_weread",
            "微信读书",
            true,
            current_site_id == "weread",
            None::<&str>,
        )?;
        menu.append(&weread_item)?;
        online_count += 1;
    }
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
        online_count += 1;
    }

    if online_count > 0 {
        menu.append(&PredefinedMenuItem::separator(manager)?)?;
    }
    let local_menu = Submenu::new(manager, "自家书屋", true)?;
    let open_item = MenuItem::with_id(
        manager,
        "open_local_book",
        "打开本地图书…",
        true,
        None::<&str>,
    )?;
    local_menu.append(&open_item)?;

    let recent = crate::local_books::list_recent(manager);
    if !recent.is_empty() {
        local_menu.append(&PredefinedMenuItem::separator(manager)?)?;
        let current_book_id = crate::local_books::current_book_id(manager);
        for book in recent {
            let item = CheckMenuItem::with_id(
                manager,
                format!("open_local_book_{}", book.book_id),
                &book.title,
                true,
                current_book_id.as_deref() == Some(book.book_id.as_str()),
                None::<&str>,
            )?;
            local_menu.append(&item)?;
        }
    }
    menu.append(&local_menu)?;
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

/// 切换到指定站点（菜单点击和快捷键共用）
/// 写 lastSiteId → 更新对勾 → 禁用阅读菜单 → 导航
pub fn switch_to_site<R: Runtime>(app: &tauri::AppHandle<R>, site_id: &str) {
    let current = current_site_id(app);
    let is_same_site = site_id == current;

    // Rust 端直接写入 lastSiteId
    let _ = crate::settings::update_setting(app, "global.lastSiteId", serde_json::json!(site_id));

    // 立即更新书店菜单对勾
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
                                if let Some(nested) = it.as_submenu() {
                                    if let Ok(nested_items) = nested.items() {
                                        for nested_item in nested_items {
                                            if let Some(check) = nested_item.as_check_menuitem() {
                                                let _ = check.set_checked(false);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 如果点击的就是当前站点，只更新对勾，不导航
    if is_same_site {
        return;
    }

    // 新页面确认进入正文前，不允许旧站点能力残留在菜单中
    disable_reader_menu_items(app);

    let settings =
        crate::settings::read_settings(app).unwrap_or_else(|_| crate::settings::default_settings());
    let remember_page = settings
        .get("global")
        .and_then(|g| g.get("lastPage"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let target = if remember_page {
        settings
            .get("sites")
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
            match url.parse::<tauri::Url>() {
                Ok(u) => {
                    let _ = win.navigate(u);
                }
                Err(e) => eprintln!("[Bookstore] Invalid URL '{}': {:?}", url, e),
            }
        }
    }
}

// Re-export monitor module functions for convenience
#[cfg(target_os = "macos")]
use crate::monitor::{
    get_current_monitor_index as get_current_screen_index, get_macos_display_names,
    move_main_window_to_monitor, start_position_monitoring,
};

#[cfg(target_os = "windows")]
use crate::monitor::{
    get_current_monitor_index as get_current_screen_index, get_display_names,
    move_main_window_to_monitor, start_position_monitoring,
};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use crate::monitor::{
    get_current_monitor_index as get_current_screen_index, get_display_names,
    move_main_window_to_monitor,
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

/// 处理菜单动作（菜单点击和前端快捷键模拟共用）
///
/// 背景：Windows + WebView2 下 muda 菜单 accelerator 全面失效（Edge 引擎在菜单
/// 消息循环之前消费了所有 Ctrl 系列键盘事件），前端需要通过 keydown 监听模拟
/// 快捷键，调用此函数复用菜单点击逻辑。
/// macOS 上菜单 accelerator 正常工作，此函数仅供菜单点击和前端模拟调用。
pub fn handle_menu_action<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "refresh" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval("window.location.reload()");
            }
        }
        "back" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval("window.__ATREADER_RUNTIME__?.back ? window.__ATREADER_RUNTIME__.back() : window.history.back()");
            }
        }
        "forward" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval("window.__ATREADER_RUNTIME__?.forward ? window.__ATREADER_RUNTIME__.forward() : window.history.forward()");
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
                let site_id = current_site_id(app);
                let current = get_current_zoom(app, &site_id);
                let next = next_zoom_level(current, true);
                let _ = win.set_zoom(next);
                save_zoom(app, &site_id, next);
                let pct = (next * 100.0).round() as i32;
                let _ = win.emit("show-toast", format!("{}%", pct));
            }
        }
        "zoom_out" => {
            if let Some(win) = app.get_webview_window("main") {
                let site_id = current_site_id(app);
                let current = get_current_zoom(app, &site_id);
                let next = next_zoom_level(current, false);
                let _ = win.set_zoom(next);
                save_zoom(app, &site_id, next);
                let pct = (next * 100.0).round() as i32;
                let _ = win.emit("show-toast", format!("{}%", pct));
            }
        }
        "zoom_reset" => {
            if let Some(win) = app.get_webview_window("main") {
                let site_id = current_site_id(app);
                let _ = win.set_zoom(1.0);
                save_zoom(app, &site_id, 1.0);
                let _ = win.emit("show-toast", "100%");
            }
        }
        "toggle_fullscreen" => {
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(is_fullscreen) = win.is_fullscreen() {
                    let _ = win.set_fullscreen(!is_fullscreen);
                    // Windows: 全屏时自动隐藏菜单栏，退出全屏时恢复
                    #[cfg(target_os = "windows")]
                    if !is_fullscreen {
                        let _ = win.hide_menu();
                        crate::commands::sync_menu_hidden_for_fullscreen(true);
                    } else {
                        let _ = win.show_menu();
                        crate::commands::sync_menu_hidden_for_fullscreen(false);
                    }
                    // macOS first responder 恢复由 watch_fullscreen_exit 负责
                    //（objc makeFirstResponder，此处立即聚焦会被全屏动画冲掉）
                }
            }
        }
        "settings" => {
            // 通过 simulate_menu_click（前端 invoke）调用时，WebView2 正在处理
            // keydown 事件，直接在此创建新窗口会死锁。放到 async_runtime 的下一轮
            // 执行，让 WebView2 先完成 keydown 处理。菜单点击路径不受影响（同步调用
            // 时 spawn 也能正常工作，只是延后了一轮事件循环）。
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(win) = app_clone.get_webview_window("settings") {
                    let _ = win.set_focus();
                } else {
                    let _ = WebviewWindowBuilder::new(
                        &app_clone,
                        "settings",
                        WebviewUrl::App("settings.html".into()),
                    )
                    .title("设置")
                    .inner_size(720.0, 600.0)
                    .center()
                    .resizable(false)
                    .build();
                }
            });
        }
        _ => {}
    }
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
        let stealth = MenuItem::with_id(handle, "stealth", "摸鱼", true, Some("CmdOrCtrl+`"))?;
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
                &stealth,
                &hide,
                &hide_others,
                &show_all,
                &PredefinedMenuItem::separator(handle)?,
                &quit,
            ],
        )?
    };

    // Windows: File Menu (stealth, toggle menu bar, settings, quit)
    #[cfg(target_os = "windows")]
    let file_menu = Submenu::with_items(
        handle,
        "文件",
        true,
        &[
            &settings,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(
                handle,
                "toggle_menu",
                "隐藏菜单\tCtrl+H",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(handle, "stealth", "摸鱼", true, Some("CmdOrCtrl+`"))?,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
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

    // 书店菜单：保持在线书店，并固定包含二级「自家书屋」入口。
    let plugin_sites = get_plugin_site_items(handle);
    let settings = settings::read_settings(handle).unwrap_or_else(|_| settings::default_settings());
    let bookstore_menu = build_bookstore_menu(
        handle,
        &plugin_sites,
        &current_site_id(handle),
        sites::is_site_enabled(&settings, sites::WEREAD.id),
    )?;

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

    // 等正文路由确认后由前端根据插件能力恢复可用项。
    disable_reader_menu_items(handle);

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
        let stealth = MenuItem::with_id(handle, "stealth", "摸鱼", true, Some("CmdOrCtrl+`"))?;
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
                &stealth,
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
        &[
            &settings,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(
                handle,
                "toggle_menu",
                "隐藏菜单\tCtrl+H",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(handle, "stealth", "摸鱼", true, Some("CmdOrCtrl+`"))?,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
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

    // 书店菜单：保持在线书店，并固定包含二级「自家书屋」入口。
    let plugin_sites = get_plugin_site_items(handle);
    let settings = settings::read_settings(handle).unwrap_or_else(|_| settings::default_settings());
    let bookstore_menu = build_bookstore_menu(
        handle,
        &plugin_sites,
        &current_site_id(handle),
        sites::is_site_enabled(&settings, sites::WEREAD.id),
    )?;

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

    // 启动时远程页面可能仍在首页，先保持所有阅读功能禁用。
    disable_reader_menu_items(handle);

    // Event Handling - use handle for move closure
    let handle_for_events = handle.clone();
    app.on_menu_event(move |app, event| {
        let id = event.id.as_ref();
        match id {
            // 以下动作已提取到 handle_menu_action，供菜单点击和前端快捷键模拟共用
            "refresh" | "back" | "forward" | "reader_wide" | "hide_cursor"
            | "hide_toolbar" | "hide_navbar" | "auto_flip"
            | "zoom_in" | "zoom_out" | "zoom_reset"
            | "toggle_fullscreen" | "settings" => {
                handle_menu_action(app, id);
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
            "stealth" => {
                crate::commands::toggle_stealth(app.clone());
            }
            "toggle_menu" => {
                crate::commands::toggle_menu_bar(app.clone());
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
                if id == "open_local_book" {
                    crate::local_books::open_dialog(app);
                    return;
                }
                if let Some(book_id) = id.strip_prefix("open_local_book_") {
                    if let Err(error) = crate::local_books::open_book_by_id(app, book_id) {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("show-toast", error);
                        }
                    }
                    return;
                }
                // 书店站点切换：菜单点击和快捷键共用 switch_to_site
                if id.starts_with("switch_site_") {
                    if let Some(site_id) = id.strip_prefix("switch_site_") {
                        switch_to_site(app, site_id);
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

                            if let Err(error) = move_main_window_to_monitor(app, index) {
                                eprintln!("[Monitor] Failed to move main window: {error}");
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
}
