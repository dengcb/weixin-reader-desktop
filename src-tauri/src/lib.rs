#![allow(unexpected_cfgs)]

use tauri::window::Color;
use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder};

mod commands;
mod menu;
pub mod monitor;
mod plugin_installer;
pub mod plugin_manager;
mod reading_progress;
mod settings;
mod sites;
mod tracker_blocker;
mod update;

const LIBRARY_PAGE: &str = "library.html";
const LIBRARY_SCHEME: &str = "atreader";
const LIBRARY_PAGE_HTML: &[u8] = include_bytes!("../../src/windows/library.html");

fn library_protocol_response(path: &str) -> tauri::http::Response<Vec<u8>> {
    if path == "/library" {
        tauri::http::Response::builder()
            .header("content-type", "text/html; charset=utf-8")
            .body(LIBRARY_PAGE_HTML.to_vec())
            .expect("valid local library response")
    } else {
        tauri::http::Response::builder()
            .status(404)
            .header("content-type", "text/plain; charset=utf-8")
            .body(b"Not Found".to_vec())
            .expect("valid local error response")
    }
}

enum MainStartupTarget {
    Online(String),
    Library,
}

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

#[cfg(test)]
fn resolve_startup_url<F>(settings: &serde_json::Value, mut resolve_home: F) -> Option<String>
where
    F: FnMut(&str) -> Option<String>,
{
    let site_id = selected_startup_site_id(settings);
    sites::is_site_enabled(settings, site_id)
        .then(|| resolve_site_url(settings, site_id, &mut resolve_home))
        .flatten()
}

fn resolve_site_url<F>(
    settings: &serde_json::Value,
    site_id: &str,
    resolve_home: &mut F,
) -> Option<String>
where
    F: FnMut(&str) -> Option<String>,
{
    let remember_page = settings
        .get("global")
        .and_then(|global| global.get("lastPage"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
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

/// 首选记忆站点；若其已禁用，则依次尝试微信读书和已启用的外部站点。
/// 没有任何在线站点可用时返回 None，由调用方打开本地默认页。
fn resolve_enabled_startup_url<F>(
    settings: &serde_json::Value,
    external_site_ids: &[String],
    mut resolve_home: F,
) -> Option<String>
where
    F: FnMut(&str) -> Option<String>,
{
    let mut candidates = vec![selected_startup_site_id(settings).to_string()];
    if !candidates.iter().any(|site_id| site_id == sites::WEREAD.id) {
        candidates.push(sites::WEREAD.id.to_string());
    }
    for site_id in external_site_ids {
        if !candidates.iter().any(|candidate| candidate == site_id) {
            candidates.push(site_id.clone());
        }
    }

    candidates.into_iter().find_map(|site_id| {
        sites::is_site_enabled(settings, &site_id)
            .then(|| resolve_site_url(settings, &site_id, &mut resolve_home))
            .flatten()
    })
}

fn installed_external_site_ids(app: &tauri::AppHandle) -> Vec<String> {
    plugin_manager::get_installed_plugins(app)
        .unwrap_or_default()
        .into_iter()
        .filter(|plugin| plugin.site.is_some())
        .map(|plugin| plugin.id)
        .collect()
}

fn main_startup_target(app: &tauri::AppHandle, settings: &serde_json::Value) -> MainStartupTarget {
    let external_site_ids = installed_external_site_ids(app);
    resolve_enabled_startup_url(settings, &external_site_ids, |site_id| {
        sites::resolve_home_url(app, site_id)
    })
    .map(MainStartupTarget::Online)
    .unwrap_or(MainStartupTarget::Library)
}

#[cfg(target_os = "windows")]
fn library_page_url() -> tauri::Url {
    "http://atreader.localhost/library"
        .parse()
        .expect("valid local library URL")
}

#[cfg(not(target_os = "windows"))]
fn library_page_url() -> tauri::Url {
    "atreader://localhost/library"
        .parse()
        .expect("valid local library URL")
}

fn navigate_to_library_when_no_online_site(app: &tauri::AppHandle) {
    let settings = settings::read_settings(app).unwrap_or_else(|_| settings::default_settings());
    if !matches!(
        main_startup_target(app, &settings),
        MainStartupTarget::Library
    ) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(library_page_url());
    }
}

fn navigate_to_enabled_site_when_on_library(app: &tauri::AppHandle) {
    let settings = settings::read_settings(app).unwrap_or_else(|_| settings::default_settings());
    let MainStartupTarget::Online(url) = main_startup_target(app, &settings) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let is_on_library = window
        .url()
        .ok()
        .is_some_and(|current| {
            current.scheme() == LIBRARY_SCHEME || current.path().ends_with(LIBRARY_PAGE)
        });
    if is_on_library {
        if let Ok(url) = url.parse::<tauri::Url>() {
            let _ = window.navigate(url);
        }
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

    let mut builder =
        tauri::Builder::default().manage(plugin_installer::PendingPluginInstallState::default());

    // 文件关联在 Windows/Linux 会启动一个新进程；必须最先注册单实例插件，
    // 才能把 .atrd 路径转交给已经运行的应用。
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            plugin_installer::handle_external_arguments(app, &args, std::path::Path::new(&cwd));
        }));
    }

    // 远程阅读页运行期间切换到默认页时，直接由专用本地协议返回编译进二进制的
    // 页面内容，避免再次经 Tauri 前端资产协议请求 library.html。
    builder = builder.register_uri_scheme_protocol(LIBRARY_SCHEME, |_context, request| {
        library_protocol_response(request.uri().path())
    });

    builder
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
            update::init(app.handle());

            // Create Main Window - determine initial URL
            // Check if we should restore the last reader page directly (to avoid flash of homepage)
            println!("[Init] App starting... Inject script size: {} bytes", inject_script.len());

            let startup_target = {
                let settings = settings::read_settings(app.handle())
                    .unwrap_or_else(|_| settings::default_settings());
                main_startup_target(app.handle(), &settings)
            };
            let is_library = matches!(&startup_target, MainStartupTarget::Library);
            let url = match startup_target {
                MainStartupTarget::Online(url_str) => {
                    println!("[Init] Restoring enabled online site: {}", url_str);
                    WebviewUrl::External(url_str.parse().unwrap())
                }
                MainStartupTarget::Library => {
                    println!("[Init] No enabled online site, loading local default page");
                    WebviewUrl::CustomProtocol(library_page_url())
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
                let zoom = if is_library {
                    1.0
                } else {
                    let site_id = selected_startup_site_id(&settings);
                    settings.get("sites")
                        .and_then(|s| s.get(site_id))
                        .and_then(|s| s.get("zoom"))
                        .and_then(|z| z.as_f64())
                        .unwrap_or(0.75)
                };
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

            // 禁用或卸载最后一个在线插件时，立即回到本地默认页，避免继续停留在
            // 已无插件支撑的远程网站；恢复插件时再从默认页回到可用书店。
            let navigation_handle = app.handle().clone();
            app.listen("plugins-updated", move |_| {
                commands::refresh_app_menu(&navigation_handle);
                navigate_to_library_when_no_online_site(&navigation_handle);
                navigate_to_enabled_site_when_on_library(&navigation_handle);
            });

            // Windows/Linux 冷启动时，关联文件路径由命令行参数传入。
            // macOS 使用下方的 RunEvent::Opened，不在这里重复处理。
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                let args: Vec<String> = std::env::args().collect();
                let cwd = std::env::current_dir().unwrap_or_default();
                plugin_installer::handle_external_arguments(app.handle(), &args, &cwd);
            }
            plugin_installer::focus_pending_plugin_install(app.handle())?;

            // 摸鱼键全局热键：Cmd/Ctrl + `
            // 必须用全局热键，因为窗口 hide() 后不接收键盘事件，窗口内 keydown 监听失效
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                // macOS = Cmd+`，Windows/Linux = Ctrl+`
                #[cfg(target_os = "macos")]
                let mod_key = Modifiers::SUPER;
                #[cfg(not(target_os = "macos"))]
                let mod_key = Modifiers::CONTROL;
                let stealth_key = Shortcut::new(Some(mod_key), Code::Backquote);
                let stealth_handle = app.handle().clone();
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |_app, shortcut, event| {
                            if shortcut == &stealth_key && event.state() == ShortcutState::Pressed {
                                commands::toggle_stealth(stealth_handle.clone());
                            }
                        })
                        .build(),
                )?;
                app.global_shortcut().register(stealth_key)?;
            }

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
            commands::toggle_stealth,
            commands::toggle_menu_bar,
            commands::simulate_menu_click,
            commands::switch_bookstore_by_index,
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
            plugin_installer::prepare_plugin_install,
            plugin_installer::get_pending_plugin_install,
            plugin_installer::confirm_pending_plugin_install,
            plugin_installer::cancel_pending_plugin_install,
            update::check_update_manual,
            update::install_update_now,
            update::is_update_downloaded
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                // ExitRequested - triggered in some cases but NOT macOS Command+Q (known bug)
                tauri::RunEvent::ExitRequested { .. } => {
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
                            menu::set_edit_menu_visible(app_handle, label == "plugin-editor");
                        }
                    }
                }
                // macOS 在冷启动和应用已运行时都通过 Opened 交付关联文件。
                // Windows/Linux 没有此变体，需 cfg 门控。
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    plugin_installer::handle_opened_urls(app_handle, &urls);
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

    #[test]
    fn startup_uses_an_enabled_external_site_when_weread_is_disabled() {
        let settings = json!({
            "global": {
                "enabledPlugins": ["fanqie"],
                "lastSiteId": "weread"
            }
        });
        assert_eq!(
            resolve_enabled_startup_url(&settings, &["fanqie".to_string()], home),
            Some("https://fanqienovel.com/".to_string())
        );
    }

    #[test]
    fn startup_has_no_online_target_when_every_plugin_is_disabled() {
        let settings = json!({
            "global": {
                "enabledPlugins": [],
                "lastSiteId": "weread"
            }
        });
        assert_eq!(
            resolve_enabled_startup_url(&settings, &["fanqie".to_string()], home),
            None
        );
    }

    #[test]
    fn local_library_protocol_serves_the_embedded_default_page() {
        let response = library_protocol_response("/library");

        assert!(response.status().is_success());
        assert_eq!(response.body().as_slice(), LIBRARY_PAGE_HTML);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(library_protocol_response("/missing").status(), 404);
    }
}
