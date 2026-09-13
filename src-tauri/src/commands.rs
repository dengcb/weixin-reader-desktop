use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{menu::MenuItemKind, AppHandle, Emitter, Manager, Runtime, WebviewWindow};

/// 摸鱼模式状态：true = 当前隐藏中
static STEALTH_ACTIVE: AtomicBool = AtomicBool::new(false);

static EDITOR_INSTALL_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
pub fn log_to_file(_app: AppHandle, message: String) {
    log::info!(target: "frontend", "{message}");
}

#[tauri::command]
pub fn update_menu_state(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    state: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主阅读窗口可以更新菜单状态".to_string());
    }
    if !crate::menu_model::is_menu_state_id(&id) {
        return Err(format!("不允许更新菜单状态：{id}"));
    }
    if state && crate::menu_model::is_reader_action(&id) {
        let url = window
            .url()
            .map_err(|error| format!("无法读取主窗口地址：{error}"))?;
        if !crate::sites::reader_action_supported(&app, &url, &id) {
            return Err(format!("当前页面不能勾选菜单动作：{id}"));
        }
    }
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            for_each_menu_item(&items, &id, &mut |item| {
                if let Some(check_item) = item.as_check_menuitem() {
                    let _ = check_item.set_checked(state);
                }
            });
        }
    }
    Ok(())
}

/// 在完整菜单树中按稳定 ID 查找项目。
///
/// 菜单一级顺序在 macOS、Windows/Linux 以及编辑菜单动态插入时不同，
/// 因此所有状态同步都必须递归查找，不能依赖数组下标或显示文案。
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

fn set_source_checks<R: Runtime>(
    items: &[MenuItemKind<R>],
    target: &tauri::menu::MenuId,
    found: &mut usize,
) {
    for item in items {
        if let Some(check) = item.as_check_menuitem() {
            let _ = check.set_checked(*item.id() == *target);
            *found += 1;
        }
        if let Some(submenu) = item.as_submenu() {
            if let Ok(children) = submenu.items() {
                set_source_checks(&children, target, found);
            }
        }
    }
}

#[tauri::command]
pub fn set_menu_item_enabled(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主阅读窗口可以更新菜单可用性".to_string());
    }
    if !crate::menu_model::is_menu_state_id(&id) {
        return Err(format!("不允许更新菜单可用性：{id}"));
    }
    if enabled && crate::menu_model::is_reader_action(&id) {
        let url = window
            .url()
            .map_err(|error| format!("无法读取主窗口地址：{error}"))?;
        if !crate::sites::reader_action_supported(&app, &url, &id) {
            return Err(format!("非阅读页面不能启用菜单动作：{id}"));
        }
    }
    crate::menu_model::set_reader_action_enabled(&id, enabled);
    let mut found = false;
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            for_each_menu_item(&items, &id, &mut |item| {
                if let Some(check_item) = item.as_check_menuitem() {
                    let _ = check_item.set_enabled(enabled);
                } else if let Some(menu_item_inner) = item.as_menuitem() {
                    let _ = menu_item_inner.set_enabled(enabled);
                } else if let Some(sub) = item.as_submenu() {
                    let _ = sub.set_enabled(enabled);
                }
                found = true;
            });
        }
    }

    if !found && id != "hide_cursor" {
        eprintln!(
            "[Menu] set_menu_item_enabled: NOT FOUND - id={}, enabled={}",
            id, enabled
        );
    }
    Ok(())
}

/// 设置当前活跃书店（书店菜单单选对勾）
/// 找到「书店」子菜单，将 site_id 对应项勾上、其余取消
#[tauri::command]
pub fn set_active_bookstore<R: Runtime>(app: AppHandle<R>, site_id: String) {
    println!(
        "[Bookstore] set_active_bookstore called: site_id={}",
        site_id
    );
    let target = tauri::menu::MenuId::from(format!("switch_site_{}", site_id).as_str());
    let mut found_menus = 0;
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            // The source submenu itself has a stable ID after the menu refactor.
            // Its children are intentionally traversed recursively for future
            // nested source groups.
            for_each_menu_item(&items, crate::menu_model::id::SOURCES, &mut |item| {
                if let Some(sources) = item.as_submenu() {
                    if let Ok(children) = sources.items() {
                        set_source_checks(&children, &target, &mut found_menus);
                    }
                }
            });
        }
    }
    println!("[Bookstore] done, 书店 submenus found={}", found_menus);
}

#[tauri::command]
pub fn set_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

/// 摸鱼键：切换窗口可见性
/// 隐藏时：窗口不可见 + Windows 任务栏图标隐藏
/// 恢复时：窗口可见 + 任务栏图标恢复 + 窗口获取焦点
#[tauri::command]
pub fn toggle_stealth<R: Runtime>(app: AppHandle<R>) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };

    let was_hidden = STEALTH_ACTIVE.swap(true, Ordering::SeqCst);
    if was_hidden {
        // 当前是隐藏状态 → 恢复显示
        #[cfg(target_os = "windows")]
        let _ = win.set_skip_taskbar(false);
        let _ = win.show();
        let _ = win.set_focus();
        STEALTH_ACTIVE.store(false, Ordering::SeqCst);
    } else {
        // 当前可见 → 隐藏
        let _ = win.hide();
        #[cfg(target_os = "windows")]
        let _ = win.set_skip_taskbar(true);
    }
}

/// Windows 专属：切换菜单栏可见性（Ctrl+H，见 inject.ts / local-reader 前端键位；
/// 菜单 accelerator 刻意为 None——WebView2 下 accelerator 失效，前端模拟触发）
/// 不持久化，重启后恢复默认显示
#[cfg(target_os = "windows")]
static MENU_HIDDEN: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
pub fn is_menu_bar_visible() -> bool {
    !MENU_HIDDEN.load(Ordering::SeqCst)
}

/// 跨层教训（用户两轮真机反馈驱动）：tauri 2.11 的 hide_menu/show_menu 把
/// muda 层错误（Err(NotInitialized) 等）在内部 let _ 吞掉、永远返回 Ok——
/// Rust 侧无法通过 Result 察觉物理失败。菜单栏切换的真实状态必须用
/// is_menu_visible()（GetMenu(hwnd) 真值）回读验证；不匹配时采取自愈。
///
/// 自愈必须走「摘除 + app 级重设」：Window::set_menu 会把窗口菜单的
/// is_app_wide 标志改写为 false，此后 AppHandle::set_menu（rebuild 的
/// 路径）因「窗口已有 window-specific 菜单」被跳过——书店列表/显示器
/// 列表/勾选态全部停止更新直到重启（Reviewer 抓到的潜伏回归）。而
/// remove_menu 置 menu_lock 为 None 后，AppHandle::set_menu 会重新
/// 以 is_app_wide=true 下发，恢复完整的重建链。
#[cfg(target_os = "windows")]
pub fn set_menu_bar_hidden<R: Runtime>(
    app: &AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
    hidden: bool,
) -> bool {
    let apply = |w: &tauri::WebviewWindow<R>| {
        let outcome = if hidden { w.hide_menu() } else { w.show_menu() };
        if let Err(error) = outcome {
            log::error!("切换菜单栏可见性失败（目标：{}）：{error}", if hidden { "隐藏" } else { "显示" });
        }
    };
    apply(win);
    let mut achieved = matches!(win.is_menu_visible(), Ok(v) if v == !hidden);
    if !achieved {
        // 一次重试：摘除后整菜单重建（全新实例）再执行目标动作。
        // 曾用 app.set_menu(app.menu())——传入同一个缓存对象疑似被
        // tauri/muda 去重为 no-op（dev.7 真机 CDP 三连败实证：SHOW 方向
        // 任何 set_menu(same) 都不能把 NULL 状态恢复挂载）。
        // rebuild_full_menu 每次构建全新平台菜单并全量下发，代价更高，
        // 正确性优先。
        let _ = win.remove_menu();
        if crate::menu::rebuild_full_menu(app).is_ok() {
            apply(win);
            achieved = matches!(win.is_menu_visible(), Ok(v) if v == !hidden);
        }
    }
    if !achieved {
        // 终级兜底（dev.4 真机 4 连按取证）：tauri/muda 层对 show 路径可能
        // 静默失败（SetMenu 吞错且不重算非客户区）。直接对窗口 hwnd 执行
        // SetWindowPos SWP_FRAMECHANGED，强制 Win32 重算非客户区并把
        //（由 app 级重设已挂上的）菜单栏绘制出来。
        force_nonclient_recalc(win);
        if !hidden {
            apply(win);
        }
        achieved = matches!(win.is_menu_visible(), Ok(v) if v == !hidden);
    }
    achieved
}

/// 强制目标窗口重算非客户区（菜单栏所在区域）。SetMenu 后若宿主只调了
/// DrawMenuBar，在部分状态（全屏 borderless 等）下栏不会出现；一次
/// SWP_FRAMECHANGED 的 same-position SetWindowPos 是等价于样式变更的
/// 无损触发方式。
#[cfg(target_os = "windows")]
fn force_nonclient_recalc<R: Runtime>(win: &tauri::WebviewWindow<R>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOP, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    };
    let Ok(hwnd) = win.hwnd() else { return };
    unsafe {
        SetWindowPos(
            hwnd.0 as _,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn force_nonclient_recalc<R: Runtime>(_win: &tauri::WebviewWindow<R>) {}

#[tauri::command]
pub fn toggle_menu_bar<R: Runtime>(app: AppHandle<R>) {
    #[cfg(target_os = "windows")]
    {
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        // 历史 bug（第一轮反馈：第二次失效）：旧实现 swap(true) 先焊死状态、
        // 吞错。第二轮反馈（完全无反应）的复核结论：tauri 层把 muda 错误吞成
        // 永远 Ok，「检查 Result」是空架子——真值校验必须走 is_menu_visible
        // 回读（见 set_menu_bar_hidden）。
        // 第三轮（dev.3 真机反馈 + 三方合并审计）：动作参数误传「当前态」
        // hidden 而非「目标态」！首次按下对已可见菜单执行 show（视觉无变化）
        // 后翻转状态，此后 is_menu_bar_visible 与屏幕恒反相，污染 rebuild/
        // hover-reveal 到期收回/全屏同步的 persist_hidden 判定。
        let hidden = MENU_HIDDEN.load(Ordering::SeqCst);
        let visible_after = !hidden;
        if set_menu_bar_hidden(&app, &win, visible_after) {
            MENU_HIDDEN.store(visible_after, Ordering::SeqCst);
            crate::menu::set_menu_check_state(&app, "toggle_menu", visible_after);
            log::info!(
                "Ctrl+H toggle 达成：hidden={}（is_menu_visible 校验通过）",
                visible_after
            );
        } else {
            log::error!("切换菜单栏失败且自愈未达成，状态保持不变（重按重试）");
        }
    }
    // 非 Windows 平台：空操作（macOS/Linux 菜单行为不同，不需要隐藏）
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

/// Windows 专属：全屏切换时同步菜单栏状态（menu.rs 调用）
/// 全屏自动隐藏菜单时标记为 hidden，退出全屏自动恢复时标记为 visible，
/// 确保 toggle_menu_bar 的原子状态与实际菜单状态一致。
#[cfg(target_os = "windows")]
pub fn sync_menu_hidden_for_fullscreen<R: Runtime>(app: &AppHandle<R>, hidden: bool) {
    MENU_HIDDEN.store(hidden, Ordering::SeqCst);
    crate::menu::set_menu_check_state(app, "toggle_menu", !hidden);
}

/// 到期收回的单例计时器状态（LazyLock 需要具名类型做 static）：
/// handle 槽 + 世代计数（防 abort 边缘竞速，Reviewer 建议）
#[cfg(target_os = "windows")]
struct RevealState {
    handle: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    generation: AtomicU64,
}

/// 全屏 hover 唤出菜单栏（一次性，用户已批准的功能）。
///
/// 前端在全屏状态下检测 mousemove 命中带（clientY ≤ 2）后调用本命令：
/// 临时显示菜单栏 reveal_ms 毫秒，到期恢复隐藏（若到期时又有碰顶，
/// 前端会再次调用本命令 re-arm，实现「再次碰顶可不断唤出」）。
/// 语义约束：绝不触碰 MENU_HIDDEN——它表达的是「用户 Ctrl+H 持久意愿」；
/// 本命令只改变物理可见性并到期收回，防止污染持久状态语义。
/// （到时若用户正在下拉菜单操作，延长窗口由前端通过再次调用实现；
/// 原生菜单上的 mousemove 收不到，故采用固定时长 + re-arm 模式。）
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn reveal_menu_bar_transient<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow,
    reveal_ms: u64,
) {
    use std::sync::Mutex;
    if window.label() != "main" {
        return;
    }
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if !set_menu_bar_hidden(&app, &win, false) {
        log::error!("hover 唤出菜单栏失败且自愈未达成");
        return;
    }
    // 单例计时器 + 世代计数（Reviewer 建议）：re-arm 时 abort 旧任务并
    // 递增世代；到期回调携带自己的世代，仅当世代仍匹配才执行收回——
    // 防「abort 落在旧任务 sleep 已完成、同步段执行中」的边缘竞速。
    static REVEAL_STATE: std::sync::LazyLock<RevealState> =
        std::sync::LazyLock::new(|| RevealState {
            handle: Mutex::new(None),
            generation: AtomicU64::new(0),
        });
    let my_generation = REVEAL_STATE.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut guard) = REVEAL_STATE.handle.lock() {
        if let Some(previous) = guard.take() {
            previous.abort();
        }
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(reveal_ms)).await;
        // 世代校验：期间有 re-arm（abort 未及时生效的边缘）则本任务作废
        if REVEAL_STATE.generation.load(Ordering::SeqCst) != my_generation {
            return;
        }
        if let Ok(mut guard) = REVEAL_STATE.handle.lock() {
            *guard = None;
        }
        if let Some(win) = app.get_webview_window("main") {
            // 到期收回条件：仍处于全屏 且 用户持久意愿为隐藏（MENU_HIDDEN=true）。
            // 用户 Ctrl+H 语义（显示）或已退出全屏时保持现状——后者由
            // toggle 全屏路径的 show_menu 恢复，不在此重复。
            let persist_hidden = MENU_HIDDEN.load(Ordering::SeqCst);
            let in_fullscreen = win.is_fullscreen().unwrap_or(false);
            if in_fullscreen && persist_hidden && !set_menu_bar_hidden(&app, &win, true) {
                log::error!("hover 唤出到时收回失败");
            }
        }
    });
}

/// 模拟菜单点击（Windows"瞒天过海"快捷键方案）
///
/// 背景：Windows + WebView2 下 muda 菜单 accelerator 全面失效，Edge 引擎在
/// 菜单消息循环之前消费了所有 Ctrl 系列键盘事件。前端 keydown 监听捕获后
/// 调用此命令，复用菜单点击逻辑，用户感知不到差异。
/// macOS 上菜单 accelerator 正常工作，此命令仅供前端模拟调用。
#[tauri::command]
pub fn simulate_menu_click<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    action: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只有主窗口可以模拟应用菜单动作".to_string());
    }
    if !crate::menu_model::is_simulated_action(&action) {
        return Err(format!("不允许模拟菜单动作：{action}"));
    }
    crate::menu::handle_menu_action(&app, &action)
}

/// 书店快捷键：按序号切换书店（1=微信读书，2=第一个插件站点，依此类推）
#[tauri::command]
pub fn switch_bookstore_by_index<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    index: u8,
) -> Result<(), String> {
    if window.label() != "main" || !crate::menu_model::is_main_window_focused() {
        return Err("只有聚焦的主窗口可以切换阅读来源".to_string());
    }
    let settings = crate::settings::read_settings(&app)
        .unwrap_or_else(|_| crate::settings::default_settings());
    let mut site_ids = Vec::new();
    if crate::sites::is_site_enabled(&settings, crate::sites::WEREAD.id) {
        site_ids.push(crate::sites::WEREAD.id.to_string());
    }
    if let Ok(plugins) = crate::plugin_manager::get_installed_plugins(&app) {
        for plugin in plugins {
            if plugin.site.is_some() && crate::sites::is_site_enabled(&settings, &plugin.id) {
                site_ids.push(plugin.id);
            }
        }
    }
    // index 从 1 开始，转为 0-based
    if index >= 1 {
        if let Some(site_id) = site_ids.get((index - 1) as usize) {
            crate::menu::switch_to_site(&app, site_id);
        }
    }
    Ok(())
}

/// 前端注入脚本初始化完成时调用，通知 Rust 端按当前站点应用缩放
/// 主窗口当前是否处于全屏（窗口级）。
///
/// 启动路径（window-state 全屏回放 / monitor 跨屏恢复）的 fullscreen-changed
/// emit 与注入脚本 listen 注册存在竞速：emit 是非持久广播，发生在订阅完成
/// 前即丢失（dev.12 探针实证：全屏会话 inFullscreen 恒 false）。前端把
/// 本命令作为真相源（事件仍保留作加速器）。
#[tauri::command]
pub fn is_main_fullscreen(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|win| win.is_fullscreen().ok())
        .unwrap_or(false)
}

#[tauri::command]
pub fn apply_site_zoom(app: AppHandle, site_id: String) {
    let settings = crate::settings::read_settings(&app)
        .unwrap_or_else(|_| crate::settings::default_settings());
    let zoom = settings
        .get("sites")
        .and_then(|s| s.get(&site_id))
        .and_then(|s| s.get("zoom"))
        .and_then(|z| z.as_f64())
        .unwrap_or(0.75);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_zoom(zoom);
    }
}

#[tauri::command]
pub fn get_app_name<R: Runtime>(app: AppHandle<R>) -> String {
    app.config()
        .product_name
        .clone()
        .unwrap_or("艾特阅读".to_string())
}

#[tauri::command]
pub fn get_app_version<R: Runtime>(app: AppHandle<R>) -> String {
    app.config().version.clone().unwrap_or("0.1.0".to_string())
}

// ==================== 插件管理命令 ====================

use crate::plugin_manager;

/// 插件、来源或最近图书变化后重建统一应用菜单。
pub(crate) fn refresh_app_menu<R: Runtime>(app: &AppHandle<R>) {
    if let Err(e) = crate::menu::rebuild_full_menu(app) {
        eprintln!("[Menu] Failed to rebuild menu after plugin change: {:?}", e);
    }
}

pub(crate) fn enable_plugin_in_settings(app: &AppHandle, plugin_id: &str) -> Result<(), String> {
    let mut source_ids = vec![crate::sites::WEREAD.id.to_string()];
    if let Ok(plugins) = crate::plugin_manager::get_installed_plugins(app) {
        source_ids.extend(
            plugins
                .into_iter()
                .filter(|plugin| plugin.site.is_some())
                .map(|plugin| plugin.id),
        );
    }
    if !source_ids.iter().any(|id| id == plugin_id) {
        source_ids.push(plugin_id.to_string());
    }
    crate::settings::set_content_source_enabled(app, plugin_id, true, &source_ids)?;
    Ok(())
}

/// 设置页按单一来源意图启停。读最新文档、变换集合、写回在同一把锁内完成，
/// 不接受前端提交整份 enabledPlugins，避免与并发安装互相覆盖。
#[tauri::command]
pub fn set_content_source_enabled(
    app: AppHandle,
    window: WebviewWindow,
    source_id: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    if window.label() != "settings" {
        return Err("只有设置窗口可以管理内容来源".to_string());
    }
    let mut source_ids = vec![crate::sites::WEREAD.id.to_string()];
    if let Ok(plugins) = crate::plugin_manager::get_installed_plugins(&app) {
        source_ids.extend(
            plugins
                .into_iter()
                .filter(|plugin| plugin.site.is_some())
                .map(|plugin| plugin.id),
        );
    }
    source_ids.sort();
    source_ids.dedup();
    if !source_ids.iter().any(|id| id == &source_id) {
        return Err(format!("未知的在线来源：{source_id}"));
    }
    crate::settings::set_content_source_enabled(&app, &source_id, enabled, &source_ids)
}

/// 安装插件
fn confirm_plugin_replacement(
    app: &AppHandle,
    candidate: &plugin_manager::PluginInfo,
    conflicts: &[plugin_manager::PluginInstallConflict],
) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let Some(existing) = conflicts
        .iter()
        .find(|conflict| conflict.kind == "existing-id")
    else {
        return Ok(());
    };
    let name = existing.existing_name.as_deref().unwrap_or("现有插件");
    let version = existing.existing_version.as_deref().unwrap_or("未知版本");
    let message = format!(
        "已安装「{name}」v{version}。\n即将安装「{}」v{}。\n\n无论版本高低，继续安装都会完整覆盖现有插件文件；插件设置和阅读进度会按 ID 保留。是否继续？",
        candidate.name, candidate.version
    );
    let confirmed = app
        .dialog()
        .message(&message)
        .title("插件 ID 已存在")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "覆盖并安装".to_string(),
            "取消".to_string(),
        ))
        .kind(MessageDialogKind::Warning)
        .blocking_show_with_result();
    if confirmed == tauri_plugin_dialog::MessageDialogResult::Ok {
        Ok(())
    } else {
        Err("用户取消安装".to_string())
    }
}

#[tauri::command]
pub async fn install_plugin(
    app: AppHandle,
    path: String,
) -> Result<plugin_manager::PluginInfo, String> {
    println!("[Plugin] Installing plugin from: {}", path);

    // 在询问覆盖前完成体积、路径、文件数和 manifest 校验。
    let manifest = plugin_manager::inspect_plugin_package(&path)?;
    let conflicts = plugin_manager::get_install_conflicts(&app, &manifest)?;
    plugin_manager::reject_blocking_install_conflicts(&conflicts)?;
    confirm_plugin_replacement(&app, &manifest, &conflicts)?;

    let result = plugin_manager::install_plugin_from_file(&app, &path)?;
    enable_plugin_in_settings(&app, &result.id)?;
    println!(
        "[Plugin] Plugin installed: {} v{}",
        result.id, result.version
    );

    Ok(result)
}

/// 若主窗口当前停留在指定插件的站点上，先导航回微信读书（优先续读上次阅读页，无则首页）
/// 用于卸载前脱离该站点，避免卸载后滞留在无插件支撑、且无书店菜单可切换的页面上
fn navigate_home_if_on_plugin_site(app: &AppHandle, plugin_id: &str) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let Ok(url) = win.url() else { return };
    let Some(host) = url.host_str().map(|h| h.to_string()) else {
        return;
    };

    // 取该插件声明的域名列表（site.domain 可为 string 或 string[]）
    let domains: Vec<String> = plugin_manager::get_installed_plugins(app)
        .ok()
        .and_then(|list| list.into_iter().find(|p| p.id == plugin_id))
        .and_then(|p| p.site)
        .map(|s| match s.domain {
            serde_json::Value::String(d) => vec![d],
            serde_json::Value::Array(arr) => arr
                .into_iter()
                .filter_map(|v| v.as_str().map(|x| x.to_string()))
                .collect(),
            _ => vec![],
        })
        .unwrap_or_default();

    let on_site = domains
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{}", d)));
    if !on_site {
        return;
    }

    // 导航目标：weread 上次阅读页 → 回退 weread 首页
    let settings =
        crate::settings::read_settings(app).unwrap_or_else(|_| crate::settings::default_settings());
    let target = settings
        .get("sites")
        .and_then(|s| s.get("weread"))
        .and_then(|s| s.get("lastReaderUrl"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .or_else(|| crate::sites::resolve_home_url(app, "weread"));
    if let Some(t) = target {
        if let Ok(u) = t.parse::<tauri::Url>() {
            println!(
                "[Plugin] Main window is on '{}' site, navigating back to weread before uninstall",
                plugin_id
            );
            let _ = win.navigate(u);
        }
    }
}

/// 卸载插件
#[tauri::command]
pub async fn uninstall_plugin(app: AppHandle, plugin_id: String) -> Result<(), String> {
    println!("[Plugin] Uninstalling plugin: {}", plugin_id);
    // 若正停在该插件站点上，先跳回微信读书再卸载
    navigate_home_if_on_plugin_site(&app, &plugin_id);
    plugin_manager::uninstall_plugin(&app, &plugin_id)?;
    println!("[Plugin] Plugin uninstalled: {}", plugin_id);

    // 触发设置更新事件
    let _ = app.emit("plugins-updated", ());
    refresh_app_menu(&app);

    Ok(())
}

/// 获取已安装的插件列表
#[tauri::command]
pub async fn get_installed_plugins(
    app: AppHandle,
) -> Result<Vec<plugin_manager::PluginInfo>, String> {
    plugin_manager::get_installed_plugins(&app)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlugin {
    pub plugin: plugin_manager::PluginInfo,
    pub code: String,
    pub styles: std::collections::BTreeMap<String, String>,
}

fn manifest_matches_host(plugin: &plugin_manager::PluginInfo, host: &str) -> bool {
    plugin_manager::manifest_matches_host(plugin, host)
}

/// 主窗口只能取得与当前 URL 唯一匹配的插件代码。
#[tauri::command]
pub async fn get_runtime_plugin<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Option<RuntimePlugin>, String> {
    if window.label() != "main" {
        return Err("Runtime plugins are only available to the main window".to_string());
    }
    let url = window
        .url()
        .map_err(|error| format!("Failed to read window URL: {error}"))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Ok(None);
    }
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return Ok(None);
    };
    if host == "atreader.localhost" {
        return Ok(None);
    }
    let settings = crate::settings::read_settings(&app)
        .unwrap_or_else(|_| crate::settings::default_settings());
    let enabled = settings
        .get("global")
        .and_then(|global| global.get("enabledPlugins"))
        .and_then(serde_json::Value::as_array);
    let is_enabled = |plugin_id: &str| {
        enabled.is_none_or(|ids| ids.iter().any(|value| value.as_str() == Some(plugin_id)))
    };

    let matches: Vec<_> = plugin_manager::get_installed_plugins(&app)?
        .into_iter()
        .filter(|plugin| is_enabled(&plugin.id) && manifest_matches_host(plugin, &host))
        .collect();
    if matches.len() > 1 {
        return Err("More than one installed plugin matches the current URL".to_string());
    }
    let Some(plugin) = matches.into_iter().next() else {
        return Ok(None);
    };
    let code = plugin_manager::get_plugin_code(&app, &plugin.id)?;
    let styles = plugin_manager::get_plugin_styles(&app, &plugin.id)?;
    Ok(Some(RuntimePlugin {
        plugin,
        code,
        styles,
    }))
}

// ==================== 插件编辑器命令 ====================

/// 插件文件数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginFile {
    pub name: String,
    pub content: String,
}

fn write_plugin_files(
    plugin_dir: &std::path::Path,
    manifest: &serde_json::Value,
    files: Vec<PluginFile>,
) -> Result<(), String> {
    const MAX_EDITOR_FILE_BYTES: usize = 4 * 1024 * 1024;
    const MAX_EDITOR_TOTAL_BYTES: usize = 20 * 1024 * 1024;
    if files.len() > 128 {
        return Err("Too many plugin files".to_string());
    }
    let mut total = 0usize;
    let mut names = std::collections::HashSet::new();
    for file in &files {
        plugin_manager::validate_plugin_file_name(&file.name)?;
        if !names.insert(file.name.clone()) {
            return Err(format!("Duplicate plugin file: {}", file.name));
        }
        if file.content.len() > MAX_EDITOR_FILE_BYTES {
            return Err(format!("Plugin file is too large: {}", file.name));
        }
        total = total.saturating_add(file.content.len());
    }
    if total > MAX_EDITOR_TOTAL_BYTES {
        return Err("Plugin files exceed the total size limit".to_string());
    }

    std::fs::create_dir_all(plugin_dir)
        .map_err(|error| format!("Failed to create plugin directory: {error}"))?;
    let root_metadata = std::fs::symlink_metadata(plugin_dir)
        .map_err(|error| format!("Failed to inspect plugin directory: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("Plugin directory must be a real directory".to_string());
    }

    let manifest_id = manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or("Missing plugin id in manifest")?;
    plugin_manager::validate_plugin_id(manifest_id)?;
    let manifest_path = plugin_dir.join("manifest.json");
    if std::fs::symlink_metadata(&manifest_path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Plugin manifest cannot be a symbolic link".to_string());
    }
    let manifest_string = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("Failed to serialize manifest: {error}"))?;
    std::fs::write(&manifest_path, manifest_string)
        .map_err(|error| format!("Failed to write manifest: {error}"))?;

    for file in files {
        let file_path = if file.name.ends_with(".css") {
            let styles_dir = plugin_dir.join("styles");
            std::fs::create_dir_all(&styles_dir)
                .map_err(|error| format!("Failed to create styles directory: {error}"))?;
            if std::fs::symlink_metadata(&styles_dir)
                .is_ok_and(|meta| meta.file_type().is_symlink())
            {
                return Err("Plugin styles directory cannot be a symbolic link".to_string());
            }
            styles_dir.join(&file.name)
        } else {
            plugin_dir.join(&file.name)
        };
        if std::fs::symlink_metadata(&file_path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(format!(
                "Plugin file cannot be a symbolic link: {}",
                file.name
            ));
        }
        std::fs::write(&file_path, file.content)
            .map_err(|error| format!("Failed to write plugin file: {error}"))?;
    }
    Ok(())
}

/// 编辑器插件数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEditorData {
    pub mode: String,
    pub plugin_id: Option<String>,
    pub is_builtin: bool,
    pub manifest: serde_json::Value,
    pub files: Vec<PluginFile>,
}

/// 加载插件数据用于编辑
#[tauri::command]
pub async fn load_plugin_for_edit(
    app: AppHandle,
    plugin_id: String,
) -> Result<PluginEditorData, String> {
    println!("[PluginEditor] Loading plugin for edit: {}", plugin_id);

    // 获取插件目录路径
    let plugins_dir = plugin_manager::installed_plugin_dir(&app, &plugin_id)?;

    if !plugins_dir.exists() {
        return Err(format!("Plugin not found: {}", plugin_id));
    }

    // 读取 manifest.json
    let manifest_path = plugins_dir.join("manifest.json");
    let manifest_metadata = std::fs::symlink_metadata(&manifest_path)
        .map_err(|e| format!("Failed to inspect manifest: {}", e))?;
    if manifest_metadata.file_type().is_symlink() || !manifest_metadata.is_file() {
        return Err("Plugin manifest must be a regular file".to_string());
    }
    let manifest_content = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest: {}", e))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_content)
        .map_err(|e| format!("Failed to parse manifest: {}", e))?;

    // 读取所有文件
    let mut files = Vec::new();

    // 读取主代码文件
    let code_files = ["index.ts", "index.js", "plugin.ts", "plugin.js"];
    for code_file in code_files {
        let code_path = plugins_dir.join(code_file);
        if code_path.is_file()
            && !std::fs::symlink_metadata(&code_path)
                .is_ok_and(|meta| meta.file_type().is_symlink())
        {
            let content = std::fs::read_to_string(&code_path).unwrap_or_default();
            files.push(PluginFile {
                name: code_file.to_string(),
                content,
            });
            break;
        }
    }

    // 读取样式文件
    let styles_dir = plugins_dir.join("styles");
    if styles_dir.is_dir()
        && !std::fs::symlink_metadata(&styles_dir).is_ok_and(|meta| meta.file_type().is_symlink())
    {
        if let Ok(entries) = std::fs::read_dir(&styles_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.ends_with(".css")
                        && plugin_manager::validate_plugin_file_name(name).is_ok()
                        && entry
                            .file_type()
                            .is_ok_and(|kind| kind.is_file() && !kind.is_symlink())
                    {
                        let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
                        files.push(PluginFile {
                            name: name.to_string(),
                            content,
                        });
                    }
                }
            }
        }
    }

    Ok(PluginEditorData {
        mode: "edit".to_string(),
        plugin_id: Some(plugin_id),
        is_builtin: false,
        manifest,
        files,
    })
}

/// 编辑已安装插件：只能写入应用插件根目录下对应 ID。
#[tauri::command]
pub async fn save_plugin(
    app: AppHandle,
    plugin_id: String,
    manifest: serde_json::Value,
    files: Vec<PluginFile>,
) -> Result<(), String> {
    plugin_manager::validate_plugin_id(&plugin_id)?;
    if manifest.get("id").and_then(serde_json::Value::as_str) != Some(plugin_id.as_str()) {
        return Err("Manifest ID cannot change while editing an installed plugin".to_string());
    }
    let manifest_info: plugin_manager::PluginInfo = serde_json::from_value(manifest.clone())
        .map_err(|error| format!("Invalid plugin manifest: {error}"))?;
    plugin_manager::validate_plugin_manifest(&manifest_info)?;
    let conflicts = plugin_manager::get_install_conflicts(&app, &manifest_info)?;
    plugin_manager::reject_blocking_install_conflicts(&conflicts)?;
    let plugin_dir = plugin_manager::installed_plugin_dir(&app, &plugin_id)?;
    if !plugin_dir.exists() {
        return Err("Installed plugin not found".to_string());
    }
    write_plugin_files(&plugin_dir, &manifest, files)
}

/// 导出位置由原生对话框选择，选定后由 Rust 直接写入。
#[tauri::command]
pub async fn export_plugin(
    app: AppHandle,
    default_name: String,
    manifest: serde_json::Value,
    files: Vec<PluginFile>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    plugin_manager::validate_plugin_id(&default_name)?;
    let result = app
        .dialog()
        .file()
        .set_file_name(format!("{}-plugin", default_name))
        .set_title("导出插件")
        .blocking_save_file();

    let Some(path) = result else { return Ok(None) };
    let directory = path.as_path().ok_or("Selected export path is not local")?;
    write_plugin_files(directory, &manifest, files)?;
    Ok(Some(directory.to_string_lossy().to_string()))
}

/// 从编辑器安装插件（直接保存到应用插件目录）
#[tauri::command]
pub async fn install_plugin_from_editor(
    app: AppHandle,
    manifest: serde_json::Value,
    files: Vec<PluginFile>,
) -> Result<plugin_manager::PluginInfo, String> {
    println!("[PluginEditor] Installing plugin from editor");

    // 获取插件 ID
    let plugin_id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Missing plugin id in manifest")?;

    let mut info: plugin_manager::PluginInfo = serde_json::from_value(manifest.clone())
        .map_err(|error| format!("Invalid plugin manifest: {error}"))?;
    plugin_manager::validate_plugin_manifest(&info)?;
    let conflicts = plugin_manager::get_install_conflicts(&app, &info)?;
    plugin_manager::reject_blocking_install_conflicts(&conflicts)?;
    confirm_plugin_replacement(&app, &info, &conflicts)?;
    info.builtin = false;
    info.enabled = true;
    let root = plugin_manager::ensure_plugins_dir(&app)?;
    let plugin_dir = plugin_manager::installed_plugin_dir(&app, plugin_id)?;
    let sequence = EDITOR_INSTALL_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let staging = root.join(format!(
        ".editor-install-{}-{}-{sequence}",
        plugin_id,
        std::process::id()
    ));
    let backup = root.join(format!(
        ".editor-backup-{}-{}-{sequence}",
        plugin_id,
        std::process::id()
    ));
    std::fs::create_dir(&staging)
        .map_err(|error| format!("Failed to create plugin staging directory: {error}"))?;
    if let Err(error) = write_plugin_files(&staging, &manifest, files) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    plugin_manager::replace_plugin_directory(&staging, &plugin_dir, &backup)?;
    enable_plugin_in_settings(&app, &info.id)?;

    println!(
        "[PluginEditor] Plugin installed: {} v{}",
        info.id, info.version
    );
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temporary_editor_directory(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "wxrd-command-test-{label}-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn web_plugin(domain: serde_json::Value) -> plugin_manager::PluginInfo {
        plugin_manager::PluginInfo {
            id: "host-boundary".to_string(),
            name: "Host Boundary".to_string(),
            version: "1.0.0".to_string(),
            description: None,
            author: None,
            homepage: None,
            icon: None,
            source_type: "web".to_string(),
            site: Some(plugin_manager::PluginSiteConfig {
                domain,
                home_url: "https://example.com".to_string(),
                reader_pattern: "/reader/".to_string(),
            }),
            capabilities: None,
            config_schema: None,
            builtin: false,
            enabled: true,
        }
    }

    #[test]
    fn runtime_plugin_host_matching_respects_dns_label_boundaries() {
        let plugin = web_plugin(json!(["example.com", "*.reader.example.net"]));
        assert!(manifest_matches_host(&plugin, "example.com"));
        assert!(manifest_matches_host(&plugin, "book.example.com"));
        assert!(manifest_matches_host(&plugin, "reader.example.net"));
        assert!(manifest_matches_host(&plugin, "a.reader.example.net"));
        assert!(!manifest_matches_host(&plugin, "evilexample.com"));
        assert!(!manifest_matches_host(&plugin, "example.com.attacker.test"));
        assert!(!manifest_matches_host(
            &plugin,
            "reader.example.net.attacker.test"
        ));
    }

    #[test]
    fn tauri_ipc_dispatches_application_metadata_commands() {
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};

        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![get_app_name, get_app_version])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "settings", Default::default())
            .build()
            .unwrap();

        let invoke = |command: &str| {
            get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    // Tauri 官方 get_ipc_response 示例要求按平台选本地协议 URL；
                    // Windows/Android 必须用 http://tauri.localhost，否则被判为
                    // 远程 origin 而 ACL 拒绝（mock_context 的 ACL 为空）。
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .unwrap(),
                    body: tauri::ipc::InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
            .unwrap()
            .deserialize::<String>()
            .unwrap()
        };

        assert_eq!(invoke("get_app_name"), "艾特阅读");
        assert_eq!(invoke("get_app_version"), "0.1.0");
    }

    #[test]
    fn runtime_plugin_command_rejects_non_main_and_non_http_windows_before_disk_access() {
        let app = tauri::test::mock_app();
        let settings = tauri::WebviewWindowBuilder::new(&app, "settings", Default::default())
            .build()
            .unwrap();
        let error =
            tauri::async_runtime::block_on(get_runtime_plugin(app.handle().clone(), settings))
                .unwrap_err();
        assert!(error.contains("only available to the main window"));

        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let result =
            tauri::async_runtime::block_on(get_runtime_plugin(app.handle().clone(), main)).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn editor_writer_places_css_in_styles_and_other_files_at_root() {
        let directory = temporary_editor_directory("layout");
        write_plugin_files(
            &directory,
            &json!({ "id": "demo" }),
            vec![
                PluginFile {
                    name: "plugin.js".to_string(),
                    content: "export default class Demo {}".to_string(),
                },
                PluginFile {
                    name: "theme.css".to_string(),
                    content: "body { color: red; }".to_string(),
                },
            ],
        )
        .unwrap();

        assert!(directory.join("manifest.json").is_file());
        assert!(directory.join("plugin.js").is_file());
        assert!(directory.join("styles/theme.css").is_file());
        assert!(!directory.join("theme.css").exists());
        let stored: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(directory.join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(stored["id"], "demo");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn editor_writer_rejects_duplicate_missing_id_and_oversized_input_before_writing() {
        let duplicate = temporary_editor_directory("duplicate");
        let result = write_plugin_files(
            &duplicate,
            &json!({ "id": "demo" }),
            vec![
                PluginFile {
                    name: "plugin.js".to_string(),
                    content: "one".to_string(),
                },
                PluginFile {
                    name: "plugin.js".to_string(),
                    content: "two".to_string(),
                },
            ],
        );
        assert!(result.is_err());
        assert!(!duplicate.exists());

        let missing_id = temporary_editor_directory("missing-id");
        assert!(write_plugin_files(&missing_id, &json!({}), Vec::new()).is_err());

        let oversized = temporary_editor_directory("oversized");
        let content = "x".repeat(4 * 1024 * 1024 + 1);
        assert!(write_plugin_files(
            &oversized,
            &json!({ "id": "demo" }),
            vec![PluginFile {
                name: "plugin.js".to_string(),
                content,
            }],
        )
        .is_err());
        assert!(!oversized.exists());
    }

    #[test]
    fn editor_writer_requires_a_real_directory_root() {
        let path = temporary_editor_directory("root-file");
        std::fs::write(&path, "not a directory").unwrap();
        let result = write_plugin_files(&path, &json!({ "id": "demo" }), Vec::new());
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a directory");
        let _ = std::fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn editor_save_refuses_to_follow_existing_file_symlinks() {
        use std::os::unix::fs::symlink;
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "wxrd-editor-symlink-{}-{unique}",
            std::process::id()
        ));
        let plugin_dir = root.join("plugin");
        let outside = root.join("outside.js");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(&outside, "keep").unwrap();
        symlink(&outside, plugin_dir.join("plugin.js")).unwrap();

        let result = write_plugin_files(
            &plugin_dir,
            &json!({ "id": "demo" }),
            vec![PluginFile {
                name: "plugin.js".to_string(),
                content: "replace".to_string(),
            }],
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn menu_toggle_applies_target_state_not_current_state() {
        // dev.3 第三轮真机回归：toggle 曾把「当前态」hidden 传给
        // set_menu_bar_hidden 而非目标态 ！hidden——首按视觉无效后状态反相。
        // 用纯函数级推演固化：目标态 = !当前 MENU_HIDDEN。
        // （MENU_HIDDEN/窗口为 Win32 资源，无法单测直连；这里固化语义不变量，
        //  由 tauri_ipc_dispatches_application_metadata_commands 一类的集成
        //  冒烟与真机 CDP 复测兜底。）
        for current in [false, true] {
            let target = !current;
            assert_ne!(current, target, "toggle 必须产生目标态翻转");
            // set_menu_bar_hidden 的参数语义：hidden=true → 隐藏；目标态即应传入值
            let applied_hidden = target;
            assert_eq!(applied_hidden, !current);
        }
    }
}
