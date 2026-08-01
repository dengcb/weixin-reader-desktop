#![allow(unexpected_cfgs)]

use tauri::window::Color;
use tauri::{WebviewUrl, WebviewWindowBuilder};

mod commands;
mod menu;
pub mod monitor;
pub mod plugin_manager;
mod reading_progress;
mod settings;
mod sites;
mod tracker_blocker;
mod update;

fn selected_startup_site_id(settings: &serde_json::Value) -> &str {
    let remember_site = settings
        .get("global")
        .and_then(|global| global.get("rememberSite"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    if !remember_site {
        return sites::WEREAD.id;
    }
    settings
        .get("global")
        .and_then(|global| global.get("lastSiteId"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(sites::WEREAD.id)
}

fn resolve_startup_url<F>(settings: &serde_json::Value, mut resolve_home: F) -> Option<String>
where
    F: FnMut(&str) -> Option<String>,
{
    let remember_page = settings
        .get("global")
        .and_then(|global| global.get("lastPage"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let site_id = selected_startup_site_id(settings);

    if remember_page {
        settings
            .get("sites")
            .and_then(|sites| sites.get(site_id))
            .and_then(|site| site.get("lastReaderUrl"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .or_else(|| resolve_home(site_id))
    } else {
        resolve_home(site_id)
    }
}

/// 清理 autoFlip.active 状态
/// 当窗口关闭或应用退出时，确保自动翻页状态被正确保存为 false
fn clear_auto_flip_active(app_handle: tauri::AppHandle, _event_name: &str) {
    let settings =
        settings::read_settings(&app_handle).unwrap_or_else(|_| settings::default_settings());

    if let Some(auto_flip) = settings
        .get("global")
        .and_then(|g| g.get("autoFlip"))
        .and_then(|v| v.as_object())
    {
        let is_active = auto_flip
            .get("active")
            .and_then(|a| a.as_bool())
            .unwrap_or(false);

        if is_active {
            let _ = settings::update_setting(
                &app_handle,
                "global.autoFlip.active",
                serde_json::json!(false),
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let inject_script = include_str!("../../src/scripts/inject.js");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_log::Builder::new().targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
        ])
        .max_file_size(2 * 1024 * 1024)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(2))
        .build())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .setup(move |app| {
            // Register cleanup callback using app.manage() + listen for exit events
            // Tauri v2 doesn't have cleanup(), use window close event instead
            // For menu quit, we handle it in menu.rs custom quit item

            // Update Manager Init
            update::init(&app.handle());

            // Create Main Window - determine initial URL
            // Check if we should restore the last reader page directly (to avoid flash of homepage)
            println!("[Init] App starting... Inject script size: {} bytes", inject_script.len());

            let url = {
                let settings = settings::read_settings(app.handle())
                    .unwrap_or_else(|_| settings::default_settings());

                // 启动 URL 解析（多站点，两个正交开关）：
                // - 「记住书店，好看再来」(global.rememberSite) 决定回哪个站点：
                //     开 → global.lastSiteId（无则 weread）；关 → 强制 weread
                // - 「阅读不停，自动记录」(global.lastPage) 决定回页还是回首页：
                //     开 → 该站点上次阅读页 sites[siteId].lastReaderUrl（无则站点首页）；关 → 站点首页
                // 两个开关互不为前提，默认均为开（向后兼容）。
                let resolved_url = resolve_startup_url(&settings, |site_id| {
                    sites::resolve_home_url(&app.handle(), site_id)
                });

                match resolved_url {
                    Some(url_str) => {
                        println!("[Init] Restoring startup URL: {}", url_str);
                        WebviewUrl::External(url_str.parse().unwrap())
                    }
                    None => {
                        println!("[Init] No startup URL resolved, loading weread homepage");
                        WebviewUrl::External(sites::DEFAULT_SITE.home_url.parse().unwrap())
                    }
                }
            };

            let app_name = app.config().product_name.clone().unwrap_or("艾特阅读".to_string());

            // IMPORTANT: Single Window Architecture
            // This application uses a single main window (label = "main") for all navigation.
            // DO NOT create additional windows for the same site - this would cause:
            // 1. Settings conflicts (multiple windows modifying the same site settings)
            // 2. Lost updates (last window to save overwrites others)
            // 3. User confusion (multiple instances of the same site)
            //
            // If multi-window support is needed in the future:
            // - Use unique labels per site (e.g., "main-weread", "main-other")
            // - Implement window focus instead of creating duplicates
            // - Add site-specific locking in settings manager

            // Platform-specific User-Agent
            // Windows: 不设置自定义 UA，使用 WebView2 原生 UA。
            //   原因：硬编码 UA 版本会与 WebView2 底层真实的 Sec-CH-UA 版本产生矛盾
            //   （navigator.userAgent 说旧版、Sec-CH-UA 说真实新版），触发微信扫码登录
            //   风控导致二维码空白。用原生 UA 表里如一，且随 WebView2 更新永不过期。
            #[cfg(target_os = "macos")]
            let user_agent: Option<&str> = Some("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15");
            #[cfg(target_os = "windows")]
            let user_agent: Option<&str> = None;
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let user_agent: Option<&str> = Some("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

            let mut builder = WebviewWindowBuilder::new(app, "main", url)
                .title(&app_name)
                .inner_size(1280.0, 800.0)
                .center()
                .background_color(Color::from((26, 26, 26))) // #1a1a1a 深灰色，减少启动时白屏闪烁
                // .initialization_script(console_filter_script)  <-- DISABLED
                .initialization_script(inject_script);
            if let Some(ua) = user_agent {
                builder = builder.user_agent(ua);
            }
            let win = builder.build()?;

            // 应用初始缩放（Tauri 2.11/wry 0.55 需要在窗口创建后主动设置）
            // zoom 按站点独立存储，从 sites[lastSiteId].zoom 读取
            {
                let settings = settings::read_settings(app.handle())
                    .unwrap_or_else(|_| settings::default_settings());
                let site_id = selected_startup_site_id(&settings);
                let zoom = settings.get("sites")
                    .and_then(|s| s.get(site_id))
                    .and_then(|s| s.get("zoom"))
                    .and_then(|z| z.as_f64())
                    .unwrap_or(0.75);
                let _ = win.set_zoom(zoom);
            }

            // 安装 tracker 拦截规则（macOS 原生 WKContentRuleList；非 macOS 为空操作）
            tracker_blocker::install(&win);

            let app_handle = app.handle().clone(); // Re-declare app_handle since we commented out the previous one

            // Handle window close event to clear autoFlip.active
            let app_handle_clone = app_handle.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    clear_auto_flip_active(app_handle_clone.clone(), "Window Close");
                }
            });

            // Menu Init - AFTER main window is created
            menu::init(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::log_to_file,
            commands::update_menu_state,
            commands::set_menu_item_enabled,
            commands::set_active_bookstore,
            settings::get_settings,
            settings::patch_settings,
            reading_progress::get_reading_position,
            reading_progress::save_reading_position,
            commands::set_title,
            commands::apply_site_zoom,
            commands::get_app_name,
            commands::get_app_version,
            commands::install_plugin,
            commands::uninstall_plugin,
            commands::get_installed_plugins,
            commands::get_runtime_plugin,
            commands::load_plugin_for_edit,
            commands::save_plugin,
            commands::export_plugin,
            commands::install_plugin_from_editor,
            update::check_update_manual,
            update::install_update_now,
            update::is_update_downloaded
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                // ExitRequested - triggered in some cases but NOT macOS Command+Q (known bug)
                tauri::RunEvent::ExitRequested { api: _, .. } => {
                    clear_auto_flip_active(app_handle.clone(), "ExitRequested");
                }
                // Exit - triggered when event loop is exiting (including macOS Command+Q)
                tauri::RunEvent::Exit => {
                    clear_auto_flip_active(app_handle.clone(), "Exit");
                }
                // WindowEvent - monitor for destroyed/close events
                tauri::RunEvent::WindowEvent { label, event, .. } => {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        println!("[WindowEvent] Window '{}' destroyed", label);
                        clear_auto_flip_active(app_handle.clone(), "WindowEvent");
                    }
                    // 编辑器窗口获得焦点时显示编辑菜单，失去焦点时隐藏
                    if let tauri::WindowEvent::Focused(focused) = event {
                        if focused {
                            menu::set_edit_menu_visible(&app_handle, label == "plugin-editor");
                        }
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn home(site_id: &str) -> Option<String> {
        match site_id {
            "weread" => Some("https://weread.qq.com/".to_string()),
            "fanqie" => Some("https://fanqienovel.com/".to_string()),
            _ => None,
        }
    }

    #[test]
    fn startup_url_restores_the_selected_sites_last_reader_page() {
        let settings = json!({
            "global": {
                "rememberSite": true,
                "lastPage": true,
                "lastSiteId": "fanqie"
            },
            "sites": {
                "fanqie": { "lastReaderUrl": "https://fanqienovel.com/reader/123" }
            }
        });
        assert_eq!(
            resolve_startup_url(&settings, home),
            Some("https://fanqienovel.com/reader/123".to_string())
        );
    }

    #[test]
    fn startup_url_uses_site_home_when_page_restore_is_disabled_or_missing() {
        let disabled = json!({
            "global": {
                "rememberSite": true,
                "lastPage": false,
                "lastSiteId": "fanqie"
            },
            "sites": {
                "fanqie": { "lastReaderUrl": "https://fanqienovel.com/reader/123" }
            }
        });
        assert_eq!(
            resolve_startup_url(&disabled, home),
            Some("https://fanqienovel.com/".to_string())
        );

        let missing = json!({
            "global": {
                "rememberSite": true,
                "lastPage": true,
                "lastSiteId": "fanqie"
            },
            "sites": {}
        });
        assert_eq!(
            resolve_startup_url(&missing, home),
            Some("https://fanqienovel.com/".to_string())
        );
    }

    #[test]
    fn startup_url_forces_weread_when_site_memory_is_disabled() {
        let settings = json!({
            "global": {
                "rememberSite": false,
                "lastPage": true,
                "lastSiteId": "fanqie"
            },
            "sites": {
                "weread": { "lastReaderUrl": "https://weread.qq.com/web/reader/book" },
                "fanqie": { "lastReaderUrl": "https://fanqienovel.com/reader/123" }
            }
        });
        assert_eq!(
            resolve_startup_url(&settings, home),
            Some("https://weread.qq.com/web/reader/book".to_string())
        );
        assert_eq!(selected_startup_site_id(&settings), "weread");
    }

    #[test]
    fn startup_url_defaults_both_flags_and_handles_unknown_sites() {
        assert_eq!(
            resolve_startup_url(&json!({}), home),
            Some("https://weread.qq.com/".to_string())
        );
        let unknown = json!({
            "global": { "lastSiteId": "missing" },
            "sites": {}
        });
        assert_eq!(resolve_startup_url(&unknown, home), None);
        assert_eq!(selected_startup_site_id(&json!({})), "weread");
        assert_eq!(selected_startup_site_id(&unknown), "missing");
    }
}
