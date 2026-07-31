#![allow(unexpected_cfgs)]

use tauri::{WebviewUrl, WebviewWindowBuilder, Manager};
use tauri::window::Color;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;
use std::path::PathBuf;

mod menu;
pub mod monitor;
mod settings;
mod commands;
mod update;
mod sites;
pub mod plugin_manager;
mod tracker_blocker;

fn check_network_connection() -> bool {
    let addr_str = sites::DEFAULT_SITE.network_check_addr();
    if let Ok(mut addrs) = addr_str.to_socket_addrs() {
        if let Some(addr) = addrs.next() {
            return TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok();
        }
    }
    false
}

/// 清理 autoFlip.active 状态
/// 当窗口关闭或应用退出时，确保自动翻页状态被正确保存为 false
fn clear_auto_flip_active(app_handle: tauri::AppHandle, event_name: &str) {
    println!("[{}] Checking autoFlip status...", event_name);
    let settings = settings::get_settings(app_handle.clone());

    if let Some(auto_flip) = settings.get("autoFlip").and_then(|v| v.as_object()) {
        let is_active = auto_flip.get("active").and_then(|a| a.as_bool()).unwrap_or(false);
        println!("[{}] autoFlip.active = {}", event_name, is_active);

        if is_active {
            let update = serde_json::json!({
                "autoFlip": {
                    "active": false,
                    "interval": auto_flip.get("interval").and_then(|i| i.as_i64()).unwrap_or(30),
                    "keepAwake": auto_flip.get("keepAwake").and_then(|k| k.as_bool()).unwrap_or(true)
                }
            });
            println!("[{}] Saving updated settings: {}", event_name, serde_json::to_string(&update).unwrap_or_else(|_| "Error".to_string()));
            settings::save_settings(app_handle.clone(), update, None);
            println!("[{}] Settings saved", event_name);
        } else {
            println!("[{}] autoFlip not active, nothing to do", event_name);
        }
    } else {
        println!("[{}] No autoFlip settings found", event_name);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let inject_script = include_str!("../../src/scripts/inject.js");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&["about", "update", "settings", "plugin-editor"]).build())
        .plugin(tauri_plugin_log::Builder::new().targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
        ]).build())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            // Register cleanup callback using app.manage() + listen for exit events
            // Tauri v2 doesn't have cleanup(), use window close event instead
            // For menu quit, we handle it in menu.rs custom quit item

            // Update Manager Init
            update::init(&app.handle());

            // Create Main Window - determine initial URL
            // Check if we should restore the last reader page directly (to avoid flash of homepage)
            println!("[Init] App starting... Inject script size: {} bytes", inject_script.len());

            let url = if check_network_connection() {
                let settings_opt: Option<String> = app.handle().path().app_config_dir()
                    .ok()
                    .and_then(|dir: PathBuf| std::fs::read_to_string(dir.join("settings.json")).ok());

                // 启动 URL 解析（多站点，两个正交开关）：
                // - 「记住书店，好看再来」(global.rememberSite) 决定回哪个站点：
                //     开 → global.lastSiteId（无则 weread）；关 → 强制 weread
                // - 「阅读不停，自动记录」(global.lastPage) 决定回页还是回首页：
                //     开 → 该站点上次阅读页 sites[siteId].lastReaderUrl（无则站点首页）；关 → 站点首页
                // 两个开关互不为前提，默认均为开（向后兼容）。
                let resolved_url: Option<String> = settings_opt
                    .as_ref()
                    .and_then(|content| serde_json::from_str::<serde_json::Value>(content).ok())
                    .and_then(|json| {
                        let remember_site = json.get("global")
                            .and_then(|g| g.get("rememberSite"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true);
                        let remember_page = json.get("global")
                            .and_then(|g| g.get("lastPage"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true);

                        let site_id = if remember_site {
                            json.get("global")
                                .and_then(|g| g.get("lastSiteId"))
                                .and_then(|v| v.as_str())
                                .unwrap_or(sites::WEREAD.id)
                                .to_string()
                        } else {
                            sites::WEREAD.id.to_string()
                        };

                        if remember_page {
                            // 优先该站点上次阅读页，其次站点首页
                            json.get("sites")
                                .and_then(|s| s.get(&site_id))
                                .and_then(|s| s.get("lastReaderUrl"))
                                .and_then(|u| u.as_str())
                                .map(|s| s.to_string())
                                .or_else(|| sites::resolve_home_url(&app.handle(), &site_id))
                        } else {
                            // 不恢复阅读页，直接站点首页
                            sites::resolve_home_url(&app.handle(), &site_id)
                        }
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
            } else {
                println!("[Init] No network connection, using local error page");
                WebviewUrl::App("index.html".into())
            };

            let app_name = app.config().product_name.clone().unwrap_or("艾特阅读".to_string());

            // Console filter and HTTPS to HTTP conversion script
            // Must be injected BEFORE the main inject script
            // DISABLED: Temporarily disabled for debugging
            #[allow(unused_variables)]
            let console_filter_script = r#"
              (function() {
                // Console filtering
                const originalWarn = console.warn;
                const originalError = console.error;
                const filterPatterns = [
                  /ipc:\/\/localhost/,
                  /requested insecure content from/,
                  /IPC custom protocol failed/,
                  /Tauri will now use the postMessage interface/,
                  /Not allowed to request resource/,
                  /Fetch API cannot load ipc:\/\//,
                  /DIN-Bold\.woff/,
                  /Source Map loading errors?/,
                  /XMLHttpRequest cannot load.*localhost\.weixin\.qq\.com/,
                  /check-login.*access control checks/,
                  /SSL error has occurred/
                ];
                console.warn = function(...args) {
                  const msg = String(args);
                  if (!filterPatterns.some(p => p.test(msg))) originalWarn.apply(console, args);
                };
                console.error = function(...args) {
                  const msg = String(args);
                  if (!filterPatterns.some(p => p.test(msg))) originalError.apply(console, args);
                };

                // HTTPS to HTTP conversion function
                function convertToHttp(url) {
                  if (typeof url === 'string' && url.includes('https://localhost.weixin.qq.com')) {
                    return url.replace('https://localhost.weixin.qq.com', 'http://localhost.weixin.qq.com');
                  }
                  return url;
                }

                // Intercept fetch and XMLHttpRequest in main window
                const originalFetch = window.fetch;
                window.fetch = function(url, options) {
                  return originalFetch.apply(this, [convertToHttp(url), options]);
                };

                const originalOpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, url) {
                  return originalOpen.apply(this, [method, convertToHttp(url)]);
                };

                // Forward console logs to Tauri backend (only in dev mode)
                const isDev = !window.__TAURI__.__currentWindow.label.includes('app.');
                const originalLog = console.log;
                console.log = function(...args) {
                  originalLog.apply(console, args);
                  if (isDev) {
                    try {
                      if (window.__TAURI__ && window.__TAURI__.core) {
                        window.__TAURI__.core.invoke('log_frontend', { message: args.map(a => String(a)).join(' ') });
                      }
                    } catch(e) {}
                  }
                };

                // Intercept in iframes as they load
                const observer = new MutationObserver((mutations) => {
                  document.querySelectorAll('iframe').forEach(iframe => {
                    try {
                      // Skip same-origin iframes (they share the window object)
                      if (iframe.contentWindow && iframe.contentWindow !== window) {
                        const injectIntoIframe = () => {
                          try {
                            // Intercept fetch and XHR in iframe
                            if (iframe.contentWindow.fetch) {
                              iframe.contentWindow.fetch = new Proxy(iframe.contentWindow.fetch, {
                                apply: (target, thisArg, args) => {
                                  if (args.length > 0) args[0] = convertToHttp(args[0]);
                                  return Reflect.apply(target, thisArg, args);
                                }
                              });
                            }
                            if (iframe.contentWindow.XMLHttpRequest) {
                              iframe.contentWindow.XMLHttpRequest.prototype.open = new Proxy(iframe.contentWindow.XMLHttpRequest.prototype.open, {
                                apply: (target, thisArg, args) => {
                                  if (args.length > 1) args[1] = convertToHttp(args[1]);
                                  return Reflect.apply(target, thisArg, args);
                                }
                              });
                            }
                          } catch (e) {
                            // Cross-origin iframe, can't inject
                          }
                        };
                        // Try to inject immediately and on load
                        injectIntoIframe();
                        iframe.addEventListener('load', injectIntoIframe);
                      } catch (e) {}
                    }
                  });
                });
                observer.observe(document.documentElement, { childList: true, subtree: true });
              })();
            "#;

            // Debug: Temporarily disable console filter script to ensure logs are visible
            // let app_handle = app.handle().clone();

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

            // 应用初始缩放（Tauri 2.11/wry 0.55 需要在窗口创建后主动设置，否则默认 zoom 可能不正确）
            // 从设置文件读取用户保存的 zoom 值，默认 0.75（Chrome 默认缩放级别）
            {
                let settings = settings::get_settings(app.handle().clone());
                let zoom = settings.get("global")
                    .and_then(|g| g.get("zoom"))
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
            commands::log_frontend,
            commands::log_to_file,
            commands::update_menu_state,
            commands::set_menu_item_enabled,
            commands::set_active_bookstore,
            settings::get_settings,
            settings::save_settings,
            commands::set_zoom,
            commands::close_window,
            commands::set_title,
            commands::get_app_name,
            commands::get_app_version,
            commands::get_available_monitors,
            commands::move_window_to_monitor,
            commands::get_current_monitor,
            commands::navigate_to_url,
            commands::set_cursor_visible,
            commands::get_weread_book_progress,
            commands::install_plugin,
            commands::uninstall_plugin,
            commands::get_installed_plugins,
            commands::get_plugin_config,
            commands::save_plugin_config,
            commands::get_plugin_code,
            commands::load_plugin_for_edit,
            commands::save_plugin,
            commands::save_plugin_dialog,
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
                }
                _ => {}
            }
        });
}
