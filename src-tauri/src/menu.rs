use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    App, AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

use crate::menu_model::{self, id as menu_id};
use crate::plugin_manager;
use crate::settings;
use crate::sites;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTarget {
    page: String,
    anchor: Option<String>,
    action: Option<String>,
}

static PENDING_SETTINGS_TARGET: std::sync::Mutex<Option<SettingsTarget>> =
    std::sync::Mutex::new(None);

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

    let Ok(ns_window_ptr) = win.ns_window() else {
        return;
    };
    let ns_window = ns_window_ptr as id;
    if ns_window.is_null() {
        return;
    }

    unsafe {
        let content_view: id = msg_send![ns_window, contentView];
        if content_view.is_null() {
            return;
        }
        let subviews: id = msg_send![content_view, subviews];
        if subviews.is_null() {
            return;
        }
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
pub fn disable_reader_menu_items<R: Runtime>(app: &AppHandle<R>) {
    menu_model::invalidate_reader_actions();
    let Some(menu) = app.menu() else { return };
    let Ok(top_items) = menu.items() else { return };
    disable_reader_items(&top_items);
}

fn disable_reader_items<R: Runtime>(items: &[MenuItemKind<R>]) {
    for item in items {
        if menu_model::is_reader_action(item.id().as_ref()) {
            if let Some(check_item) = item.as_check_menuitem() {
                let _ = check_item.set_enabled(false);
            } else if let Some(menu_item) = item.as_menuitem() {
                let _ = menu_item.set_enabled(false);
            }
        }
        if let Some(submenu) = item.as_submenu() {
            if let Ok(children) = submenu.items() {
                disable_reader_items(&children);
            }
        }
    }
}

fn for_each_menu_item<R: Runtime>(
    items: &[MenuItemKind<R>],
    id: &str,
    callback: &mut impl FnMut(&MenuItemKind<R>),
) {
    for item in items {
        if item.id().as_ref() == id {
            callback(item);
        }
        if let Some(submenu) = item.as_submenu() {
            if let Ok(children) = submenu.items() {
                for_each_menu_item(&children, id, callback);
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub fn set_menu_check_state<R: Runtime>(app: &AppHandle<R>, id: &str, checked: bool) {
    let Some(menu) = app.menu() else { return };
    let Ok(items) = menu.items() else { return };
    for_each_menu_item(&items, id, &mut |item| {
        if let Some(check) = item.as_check_menuitem() {
            let _ = check.set_checked(checked);
        }
    });
}

fn set_source_checks<R: Runtime>(items: &[MenuItemKind<R>], target: &tauri::menu::MenuId) {
    for item in items {
        if let Some(check) = item.as_check_menuitem() {
            let _ = check.set_checked(*item.id() == *target);
        }
        if let Some(submenu) = item.as_submenu() {
            if let Ok(children) = submenu.items() {
                set_source_checks(&children, target);
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
        if submenu.id().as_ref() == menu_id::EDIT {
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
            // macOS 有“应用、文件”两个前置菜单；其他平台只有“文件”。
            let edit_menu = match Submenu::with_id_and_items(
                app,
                menu_id::EDIT,
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
            #[cfg(target_os = "macos")]
            let edit_index = 2;
            #[cfg(not(target_os = "macos"))]
            let edit_index = 1;
            let _ = menu.insert(&edit_menu, edit_index);
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

/// 构建「在线来源」子菜单。
/// 在线站点保持现有顺序，当前来源前面显示对勾；本地图书入口归入「文件」。
fn build_sources_menu<R: Runtime>(
    manager: &tauri::AppHandle<R>,
    plugin_sites: &[PluginSiteMenuItem],
    current_site_id: &str,
    weread_enabled: bool,
) -> tauri::Result<Option<Submenu<R>>> {
    let menu = Submenu::with_id(manager, menu_id::SOURCES, "在线来源", true)?;
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
    if online_count == 0 {
        let empty = MenuItem::with_id(
            manager,
            "no_enabled_sources",
            "暂无已启用的在线来源",
            false,
            None::<&str>,
        )?;
        menu.append(&empty)?;
    }
    Ok(Some(menu))
}

fn build_recent_books_menu<R: Runtime>(
    manager: &tauri::AppHandle<R>,
    manage_history: &MenuItem<R>,
) -> tauri::Result<Submenu<R>> {
    let menu = Submenu::with_id(manager, menu_id::RECENT, "最近打开", true)?;
    let recent = crate::local_books::list_recent(manager);
    if recent.is_empty() {
        menu.append(&MenuItem::with_id(
            manager,
            "no_recent_books",
            "暂无最近打开的图书",
            false,
            None::<&str>,
        )?)?;
    } else {
        let current_book_id = crate::local_books::current_book_id(manager);
        for book in recent.into_iter().take(10) {
            let item = CheckMenuItem::with_id(
                manager,
                format!("open_local_book_{}", book.book_id),
                &book.title,
                true,
                current_book_id.as_deref() == Some(book.book_id.as_str()),
                None::<&str>,
            )?;
            menu.append(&item)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(manager)?)?;
    menu.append(manage_history)?;
    Ok(menu)
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
            for_each_menu_item(&items, menu_id::SOURCES, &mut |item| {
                let Some(submenu) = item.as_submenu() else {
                    return;
                };
                if let Ok(sub_items) = submenu.items() {
                    set_source_checks(&sub_items, &target);
                }
            });
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
fn open_settings_target<R: Runtime>(
    app: &AppHandle<R>,
    page: &str,
    anchor: Option<&str>,
    action: Option<&str>,
) {
    let target = SettingsTarget {
        page: page.to_string(),
        anchor: anchor.map(str::to_string),
        action: action.map(str::to_string),
    };
    if let Ok(mut pending) = PENDING_SETTINGS_TARGET.lock() {
        *pending = Some(target.clone());
    }
    let page_value = target.page.clone();
    let anchor_value = target.anchor.clone();
    let action_value = target.action.clone();
    let url = {
        let mut query = format!("?tab={}", page_value);
        if let Some(anchor) = anchor_value.as_deref() {
            query.push_str("&anchor=");
            query.push_str(anchor);
        }
        if let Some(action) = action_value.as_deref() {
            query.push_str("&action=");
            query.push_str(action);
        }
        format!("settings.html{query}")
    };
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(win) = app_clone.get_webview_window("settings") {
            let _ = win.set_focus();
            let _ = win.emit("settings-target-pending", ());
        } else {
            let _ = WebviewWindowBuilder::new(&app_clone, "settings", WebviewUrl::App(url.into()))
                .title("设置")
                .inner_size(900.0, 700.0)
                .min_inner_size(760.0, 560.0)
                .center()
                .resizable(true)
                .build();
        }
    });
}

#[tauri::command]
pub fn claim_settings_target(
    window: tauri::WebviewWindow,
) -> Result<Option<SettingsTarget>, String> {
    if window.label() != "settings" {
        return Err("只有设置窗口可以领取设置导航目标".to_string());
    }
    PENDING_SETTINGS_TARGET
        .lock()
        .map(|mut pending| pending.take())
        .map_err(|_| "设置导航状态锁已损坏".to_string())
}

fn action_requires_main_focus(id: &str) -> bool {
    matches!(
        id,
        "refresh"
            | "back"
            | "forward"
            | "reader_wide"
            | "hide_cursor"
            | "hide_toolbar"
            | "hide_navbar"
            | "auto_flip"
            | "reader_prev_page"
            | "reader_next_page"
            | "reader_prev_chapter"
            | "reader_next_chapter"
            | "reader_style"
            | "zoom_in"
            | "zoom_out"
            | "zoom_reset"
            | "toggle_fullscreen"
    )
}

pub fn handle_menu_action<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    if action_requires_main_focus(id) && !menu_model::is_main_window_focused() {
        return Err(format!("当前窗口不能执行菜单动作：{id}"));
    }
    if menu_model::is_reader_action(id) && !menu_model::is_reader_action_enabled(id) {
        return Err(format!("当前页面不支持菜单动作：{id}"));
    }
    if menu_model::is_reader_action(id) {
        let Some(window) = app.get_webview_window("main") else {
            return Err("主阅读窗口不存在".to_string());
        };
        let url = window
            .url()
            .map_err(|error| format!("无法读取主窗口地址：{error}"))?;
        if !sites::reader_action_supported(app, &url, id) {
            disable_reader_menu_items(app);
            return Err(format!("非阅读页面不能执行菜单动作：{id}"));
        }
    }
    match id {
        "open_local_book" => {
            crate::local_books::open_dialog(app);
        }
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
        "reader_prev_page"
        | "reader_next_page"
        | "reader_prev_chapter"
        | "reader_next_chapter"
        | "reader_style" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.emit("menu-action", id);
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
                    // Windows: 全屏时自动隐藏菜单栏，退出全屏时恢复。
                    // 回读自愈与 toggle_menu_bar 同构：真值校验走
                    // is_menu_visible，达成后才同步 MENU_HIDDEN
                    #[cfg(target_os = "windows")]
                    {
                        let hidden_after = !is_fullscreen; // 进入全屏(切前非全屏)→隐藏
                        if crate::commands::set_menu_bar_hidden(app, &win, hidden_after) {
                            crate::commands::sync_menu_hidden_for_fullscreen(app, hidden_after);
                        } else {
                            log::error!("全屏切换时同步菜单栏失败且自愈未达成");
                        }
                        // 全屏状态广播：前端据此启用「鼠标碰顶边唤出菜单栏」
                        // 命中带（hover reveal）。Windows 全屏是 borderless，
                        // OS 层无顶边唤出行为，需应用自建命中区
                        let _ = win.emit("fullscreen-changed", !is_fullscreen);
                    }
                    // macOS first responder 恢复由 watch_fullscreen_exit 负责
                    //（objc makeFirstResponder，此处立即聚焦会被全屏动画冲掉）
                }
            }
        }
        "settings" => {
            open_settings_target(app, "general", None, None);
        }
        "settings_reading" => open_settings_target(app, "reading", Some("auto-flip"), None),
        "settings_content" => open_settings_target(app, "content", None, None),
        "settings_data" => open_settings_target(app, "data", Some("local-history"), None),
        "shortcuts" => open_settings_target(app, "reading", Some("shortcuts"), None),
        "help" => {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_url(
                "https://github.com/dengcb/weixin-reader-desktop#readme",
                None::<&str>,
            );
        }
        "feedback" => {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_url(
                "https://github.com/dengcb/weixin-reader-desktop/issues",
                None::<&str>,
            );
        }
        "about" => open_settings_target(app, "about", None, None),
        "check_update" => open_settings_target(app, "about", Some("update"), Some("check_update")),
        "stealth" => crate::commands::toggle_stealth(app.clone()),
        "toggle_menu" => crate::commands::toggle_menu_bar(app.clone()),
        _ => {}
    }
    Ok(())
}

/// 创建完整菜单树。启动和动态重建必须共用这一入口，避免菜单结构与状态句柄
/// 在两个实现中逐渐分叉。平台差异只保留在顶层菜单顺序和系统预定义项目上。
fn build_app_menu<R: Runtime>(
    handle: &tauri::AppHandle<R>,
) -> tauri::Result<(Menu<R>, MenuItem<R>)> {
    let initial = get_initial_settings(handle);
    let app_name = "艾特阅读";

    let about = MenuItem::with_id(handle, "about", "关于艾特阅读", true, None::<&str>)?;
    let check_update = MenuItem::with_id(handle, "check_update", "检查更新…", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "设置…", true, Some("CmdOrCtrl+,"))?;
    let settings_reading = MenuItem::with_id(
        handle,
        "settings_reading",
        "自动翻页设置…",
        true,
        None::<&str>,
    )?;
    let settings_content = MenuItem::with_id(
        handle,
        "settings_content",
        "管理内容与扩展…",
        true,
        None::<&str>,
    )?;
    let settings_data =
        MenuItem::with_id(handle, "settings_data", "管理阅读记录…", true, None::<&str>)?;

    let open_local = MenuItem::with_id(
        handle,
        "open_local_book",
        "打开本地图书…",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let recent_menu = build_recent_books_menu(handle, &settings_data)?;
    let file_sep = PredefinedMenuItem::separator(handle)?;
    let close_window = PredefinedMenuItem::close_window(handle, Some("关闭窗口"))?;

    #[cfg(target_os = "macos")]
    let file_menu = Submenu::with_id_and_items(
        handle,
        menu_id::FILE,
        "文件",
        true,
        &[&open_local, &recent_menu, &file_sep, &close_window],
    )?;

    #[cfg(not(target_os = "macos"))]
    let file_menu = {
        let quit = PredefinedMenuItem::quit(handle, Some("退出"))?;
        let file_sep3 = PredefinedMenuItem::separator(handle)?;
        Submenu::with_id_and_items(
            handle,
            menu_id::FILE,
            "文件",
            true,
            &[
                &open_local,
                &recent_menu,
                &file_sep,
                &settings,
                &file_sep3,
                &quit,
            ],
        )?
    };

    let refresh = MenuItem::with_id(handle, "refresh", "重新加载", true, Some("CmdOrCtrl+R"))?;
    let back = MenuItem::with_id(handle, "back", "后退", true, Some("CmdOrCtrl+["))?;
    let forward = MenuItem::with_id(handle, "forward", "前进", true, Some("CmdOrCtrl+]"))?;
    let prev_page = MenuItem::with_id(handle, "reader_prev_page", "上一页 ←", true, None::<&str>)?;
    let next_page = MenuItem::with_id(handle, "reader_next_page", "下一页 →", true, None::<&str>)?;
    let prev_chapter =
        MenuItem::with_id(handle, "reader_prev_chapter", "上一章 ↑", true, None::<&str>)?;
    let next_chapter =
        MenuItem::with_id(handle, "reader_next_chapter", "下一章 ↓", true, None::<&str>)?;
    let auto_flip = CheckMenuItem::with_id(
        handle,
        "auto_flip",
        "自动翻页",
        true,
        initial.auto_flip_active,
        Some("CmdOrCtrl+I"),
    )?;
    let reader_style = MenuItem::with_id(handle, "reader_style", "阅读样式…", true, None::<&str>)?;
    let reading_sep = PredefinedMenuItem::separator(handle)?;
    let reading_sep2 = PredefinedMenuItem::separator(handle)?;
    let reading_menu = Submenu::with_id_and_items(
        handle,
        menu_id::READING,
        "阅读",
        true,
        &[
            &prev_page,
            &next_page,
            &prev_chapter,
            &next_chapter,
            &reading_sep,
            &auto_flip,
            &settings_reading,
            &reading_sep2,
            &reader_style,
        ],
    )?;

    let sources = build_sources_menu(
        handle,
        &get_plugin_site_items(handle),
        &current_site_id(handle),
        sites::is_site_enabled(
            &settings::read_settings(handle).unwrap_or_else(|_| settings::default_settings()),
            sites::WEREAD.id,
        ),
    )?;
    let go_sep = PredefinedMenuItem::separator(handle)?;
    let go_sep2 = PredefinedMenuItem::separator(handle)?;
    let go_items: Vec<&dyn tauri::menu::IsMenuItem<R>> = match sources.as_ref() {
        Some(sources) => vec![
            &back,
            &forward,
            &go_sep,
            sources,
            &go_sep2,
            &settings_content,
        ],
        None => vec![&back, &forward, &go_sep, &go_sep2, &settings_content],
    };
    let go_menu = Submenu::with_id_and_items(handle, menu_id::GO, "前往", true, &go_items)?;

    let zoom_reset =
        MenuItem::with_id(handle, "zoom_reset", "实际大小", true, Some("CmdOrCtrl+0"))?;
    let zoom_in = MenuItem::with_id(handle, "zoom_in", "放大", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(handle, "zoom_out", "缩小", true, Some("CmdOrCtrl+-"))?;
    let zoom_sep = PredefinedMenuItem::separator(handle)?;
    let zoom_menu = Submenu::with_id_and_items(
        handle,
        menu_id::ZOOM,
        "页面缩放",
        true,
        &[&zoom_in, &zoom_out, &zoom_sep, &zoom_reset],
    )?;
    let reader_wide = CheckMenuItem::with_id(
        handle,
        "reader_wide",
        "宽屏阅读",
        true,
        initial.reader_wide,
        Some("CmdOrCtrl+9"),
    )?;
    let hide_toolbar = CheckMenuItem::with_id(
        handle,
        "hide_toolbar",
        "隐藏阅读工具栏",
        true,
        initial.hide_toolbar,
        Some("CmdOrCtrl+O"),
    )?;
    let hide_navbar = CheckMenuItem::with_id(
        handle,
        "hide_navbar",
        "隐藏阅读导航栏",
        true,
        initial.hide_navbar,
        Some("CmdOrCtrl+P"),
    )?;
    #[cfg(target_os = "macos")]
    let fullscreen = PredefinedMenuItem::fullscreen(handle, Some("切换全屏"))?;
    #[cfg(not(target_os = "macos"))]
    let fullscreen = MenuItem::with_id(handle, "toggle_fullscreen", "切换全屏", true, Some("F11"))?;
    let view_sep = PredefinedMenuItem::separator(handle)?;
    let view_sep2 = PredefinedMenuItem::separator(handle)?;
    let view_sep3 = PredefinedMenuItem::separator(handle)?;
    #[cfg(target_os = "windows")]
    let toggle_menu = CheckMenuItem::with_id(
        handle,
        "toggle_menu",
        "显示菜单栏\tCtrl+H",
        true,
        crate::commands::is_menu_bar_visible(),
        None::<&str>,
    )?;

    #[cfg(target_os = "windows")]
    let view_menu = Submenu::with_id_and_items(
        handle,
        menu_id::VIEW,
        "视图",
        true,
        &[
            &refresh,
            &view_sep,
            &zoom_menu,
            &view_sep2,
            &reader_wide,
            &hide_toolbar,
            &hide_navbar,
            &view_sep3,
            &fullscreen,
            &toggle_menu,
        ],
    )?;
    #[cfg(not(target_os = "windows"))]
    let view_menu = Submenu::with_id_and_items(
        handle,
        menu_id::VIEW,
        "视图",
        true,
        &[
            &refresh,
            &view_sep,
            &zoom_menu,
            &view_sep2,
            &reader_wide,
            &hide_toolbar,
            &hide_navbar,
            &view_sep3,
            &fullscreen,
        ],
    )?;

    let minimize = PredefinedMenuItem::minimize(handle, Some("最小化"))?;
    let monitor_items = build_monitor_menu_items(handle)?;
    let monitor_menu = Submenu::with_id(
        handle,
        "menu_monitors",
        "移动到显示器",
        !monitor_items.is_empty(),
    )?;
    for item in &monitor_items {
        monitor_menu.append(item)?;
    }
    let window_sep = PredefinedMenuItem::separator(handle)?;
    let stealth = MenuItem::with_id(handle, "stealth", "快速隐藏", true, Some("CmdOrCtrl+`"))?;
    let window_menu = Submenu::with_id_and_items(
        handle,
        menu_id::WINDOW,
        "窗口",
        true,
        &[&minimize, &monitor_menu, &window_sep, &stealth],
    )?;

    #[cfg(not(target_os = "macos"))]
    let help_menu = {
        let help_sep = PredefinedMenuItem::separator(handle)?;
        Submenu::with_id_and_items(
            handle,
            menu_id::HELP,
            "帮助",
            true,
            &[
                &MenuItem::with_id(handle, "shortcuts", "快捷键参考…", true, None::<&str>)?,
                &MenuItem::with_id(handle, "help", "使用帮助", true, None::<&str>)?,
                &MenuItem::with_id(handle, "feedback", "反馈问题", true, None::<&str>)?,
                &help_sep,
                &check_update,
                &about,
            ],
        )?
    };
    #[cfg(target_os = "macos")]
    let help_menu = {
        Submenu::with_id_and_items(
            handle,
            menu_id::HELP,
            "帮助",
            true,
            &[
                &MenuItem::with_id(handle, "shortcuts", "快捷键参考…", true, None::<&str>)?,
                &MenuItem::with_id(handle, "help", "使用帮助", true, None::<&str>)?,
                &MenuItem::with_id(handle, "feedback", "反馈问题", true, None::<&str>)?,
            ],
        )?
    };

    #[cfg(target_os = "macos")]
    let app_menu = {
        let app_sep = PredefinedMenuItem::separator(handle)?;
        let app_sep2 = PredefinedMenuItem::separator(handle)?;
        let app_sep3 = PredefinedMenuItem::separator(handle)?;
        let hide = PredefinedMenuItem::hide(handle, Some("隐藏"))?;
        let hide_others = PredefinedMenuItem::hide_others(handle, Some("隐藏其他"))?;
        let show_all = PredefinedMenuItem::show_all(handle, Some("显示全部"))?;
        let quit = PredefinedMenuItem::quit(handle, Some("退出艾特阅读"))?;
        Submenu::with_id_and_items(
            handle,
            "menu_app",
            app_name,
            true,
            &[
                &about,
                &check_update,
                &app_sep,
                &settings,
                &app_sep2,
                &hide,
                &hide_others,
                &show_all,
                &app_sep3,
                &quit,
            ],
        )?
    };

    #[cfg(target_os = "macos")]
    let menu = Menu::with_items(
        handle,
        &[
            &app_menu,
            &file_menu,
            &reading_menu,
            &go_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )?;
    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(
        handle,
        &[
            &file_menu,
            &reading_menu,
            &go_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )?;

    Ok((menu, check_update))
}

/// Rebuild the entire menu (called after window moves)
/// This recreates the menu with updated monitor items based on current window position
pub fn rebuild_full_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let (menu, check_update) = build_app_menu(handle)?;
    handle.set_menu(menu)?;
    if let Some(state) = handle.try_state::<crate::update::MenuState<R>>() {
        if let Ok(mut guard) = state.check_update_item.lock() {
            *guard = Some(check_update);
        }
    }
    disable_reader_menu_items(handle);
    // set_menu 会把 (Windows 上已隐藏的) 菜单栏重新挂回窗口——rebuild
    // 必须感知 MENU_HIDDEN，否则隐藏状态下任何一次重建（窗口移动/插件
    // 变化触发）都把菜单栏闪现出来，且 MENU_HIDDEN 与屏幕状态脱钩，
    // 下一次 Ctrl+H 从 toggle 变成对错误分支的 no-op（用户反馈的单向失效的
    // 现实触发器）。rebuild 后按持久状态补齐 hide。
    //
    // 同函数顺带覆盖「全屏路径不对称」：冷启动（window-state 回放
    // FULLSCREEN）与跨屏移动恢复全屏（monitor.rs）都直接调
    // set_fullscreen 绕过了 toggle_fullscreen 里的 hide_menu——这两条
    // 路径均伴随或不晚于此处的菜单重建，因此在这里按窗口实际全屏状态
    // 校正菜单可见性，不再各路径分散补丁。
    #[cfg(target_os = "windows")]
    if let Some(main_window) = handle.get_webview_window("main") {
        let should_hide = if main_window.is_fullscreen().unwrap_or(false) {
            true
        } else {
            !crate::commands::is_menu_bar_visible()
        };
        if should_hide {
            // 回读自愈（同 toggle_menu_bar）：tauri 层吞错使 Result 不可信，
            // 物理状态以 is_menu_visible 真值为准；rebuild 的 set_menu 已把
            // 菜单挂回，这里按目标态收敛并二次验证
            crate::commands::set_menu_bar_hidden(handle, &main_window, true);
            if main_window.is_fullscreen().unwrap_or(false) {
                crate::commands::sync_menu_hidden_for_fullscreen(handle, true);
            }
        }
    }
    if let Some(main_window) = handle.get_webview_window("main") {
        let _ = main_window.emit("menu-rebuilt", ());
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

    let (menu, check_update) = build_app_menu(handle)?;
    app.manage(crate::update::MenuState {
        check_update_item: std::sync::Mutex::new(Some(check_update)),
    });
    app.set_menu(menu)?;

    // 启动时远程页面可能仍在首页，先保持所有阅读功能禁用。
    disable_reader_menu_items(handle);

    // Event Handling - use handle for move closure
    let handle_for_events = handle.clone();
    app.on_menu_event(move |app, event| {
        let id = event.id.as_ref();
        match id {
            // 以下动作已提取到 handle_menu_action，供菜单点击和前端快捷键模拟共用
            "refresh"
            | "back"
            | "forward"
            | "reader_prev_page"
            | "reader_next_page"
            | "reader_prev_chapter"
            | "reader_next_chapter"
            | "reader_style"
            | "reader_wide"
            | "hide_cursor"
            | "hide_toolbar"
            | "hide_navbar"
            | "auto_flip"
            | "zoom_in"
            | "zoom_out"
            | "zoom_reset"
            | "toggle_fullscreen"
            | "settings"
            | "settings_reading"
            | "settings_content"
            | "settings_data"
            | "shortcuts"
            | "help"
            | "feedback" => {
                let _ = handle_menu_action(app, id);
            }
            "about" => {
                open_settings_target(app, "about", None, None);
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
                    // 已下载状态先交给设置页展示；用户确认后再触发安装/重启。
                    open_settings_target(app, "about", Some("update"), None);
                } else {
                    open_settings_target(app, "about", Some("update"), Some("check"));
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
                if let Some(auto_flip) = settings
                    .get("global")
                    .and_then(|g| g.get("autoFlip"))
                    .and_then(|v| v.as_object())
                {
                    if auto_flip
                        .get("active")
                        .and_then(|a| a.as_bool())
                        .unwrap_or(false)
                    {
                        let _ = crate::settings::update_setting(
                            &handle_for_events,
                            "global.autoFlip.active",
                            serde_json::json!(false),
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
                        if menu_model::is_main_window_focused() {
                            switch_to_site(app, site_id);
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
                            eprintln!(
                                "DEBUG: Move request: current={:?}, target={}",
                                current_screen_index, index
                            );

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
    let document = settings::read_settings(handle).unwrap_or_else(|_| settings::default_settings());
    initial_settings_from_document(&document)
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
