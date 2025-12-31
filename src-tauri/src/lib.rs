#![allow(unexpected_cfgs)]

use tauri::{WebviewUrl, WebviewWindowBuilder, Manager};
use tauri::window::Color;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;
use std::path::PathBuf;

mod menu;
mod monitor;
mod settings;
mod commands;
mod update;

fn check_network_connection() -> bool {
    let addr_str = "weread.qq.com:443";
    if let Ok(mut addrs) = addr_str.to_socket_addrs() {
        if let Some(addr) = addrs.next() {
            return TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok();
        }
    }
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let inject_script = include_str!("../../src/scripts/inject.js");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&["about", "update", "settings"]).build())
        .plugin(tauri_plugin_log::Builder::default().build())
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
            let url = if check_network_connection() {
                let settings_opt: Option<String> = app.handle().path().app_config_dir()
                    .ok()
                    .and_then(|dir: PathBuf| std::fs::read_to_string(dir.join("settings.json")).ok());

                if let Some(settings_content) = settings_opt {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&settings_content) {
                        let last_page_enabled = json.get("lastPage")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        let last_reader_url = json.get("lastReaderUrl")
                            .and_then(|v| v.as_str());

                        if last_page_enabled && last_reader_url.is_some() {
                            let url_str = last_reader_url.unwrap();
                            println!("[Init] Restoring last reader page directly: {}", url_str);
                            WebviewUrl::External(url_str.parse().unwrap())
                        } else {
                            println!("[Init] lastPage disabled or no URL, loading homepage");
                            WebviewUrl::External("https://weread.qq.com/".parse().unwrap())
                        }
                    } else {
                        WebviewUrl::External("https://weread.qq.com/".parse().unwrap())
                    }
                } else {
                    WebviewUrl::External("https://weread.qq.com/".parse().unwrap())
                }
            } else {
                println!("[Init] No network connection, using local error page");
                WebviewUrl::App("index.html".into())
            };

            let app_name = app.config().product_name.clone().unwrap_or("微信阅读".to_string());

            // Console filter and HTTPS to HTTP conversion script
            // Must be injected BEFORE the main inject script
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

            let app_handle = app.handle().clone();
            let win = WebviewWindowBuilder::new(app, "main", url)
                .title(&app_name)
                .inner_size(1280.0, 800.0)
                .center()
                .background_color(Color::from((26, 26, 26))) // #1a1a1a 深灰色，减少启动时白屏闪烁
                .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36")
                .initialization_script(console_filter_script)
                .initialization_script(inject_script)
                .build()?;

            // Handle window close event to clear autoFlip.active
            let app_handle_clone = app_handle.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    println!("[Window Close] Window close requested, checking autoFlip...");
                    // Clear autoFlip.active when window is closing
                    let settings = settings::get_settings(app_handle_clone.clone());
                    println!("[Window Close] Current settings: {}", serde_json::to_string(&settings).unwrap_or_else(|_| "Error".to_string()));

                    if let Some(auto_flip) = settings.get("autoFlip").and_then(|v| v.as_object()) {
                        let is_active = auto_flip.get("active").and_then(|a| a.as_bool()).unwrap_or(false);
                        println!("[Window Close] autoFlip.active = {}", is_active);

                        if is_active {
                            let update = serde_json::json!({
                                "autoFlip": {
                                    "active": false,
                                    "interval": auto_flip.get("interval").and_then(|i| i.as_i64()).unwrap_or(30),
                                    "keepAwake": auto_flip.get("keepAwake").and_then(|k| k.as_bool()).unwrap_or(true)
                                }
                            });
                            println!("[Window Close] Saving updated settings: {}", serde_json::to_string(&update).unwrap_or_else(|_| "Error".to_string()));
                            settings::save_settings(app_handle_clone.clone(), update, None);
                            println!("[Window Close] Settings saved");
                        } else {
                            println!("[Window Close] autoFlip not active, nothing to do");
                        }
                    } else {
                        println!("[Window Close] No autoFlip settings found");
                    }
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
                    println!("[ExitRequested] Application exit requested, clearing autoFlip.active");
                    let settings = settings::get_settings(app_handle.clone());
                    if let Some(auto_flip) = settings.get("autoFlip").and_then(|v| v.as_object()) {
                        if auto_flip.get("active").and_then(|a| a.as_bool()).unwrap_or(false) {
                            let update = serde_json::json!({
                                "autoFlip": {
                                    "active": false,
                                    "interval": auto_flip.get("interval").and_then(|i| i.as_i64()).unwrap_or(30),
                                    "keepAwake": auto_flip.get("keepAwake").and_then(|k| k.as_bool()).unwrap_or(true)
                                }
                            });
                            println!("[ExitRequested] Saving updated settings: {}", serde_json::to_string(&update).unwrap_or_else(|_| "Error".to_string()));
                            settings::save_settings(app_handle.clone(), update, None);
                            println!("[ExitRequested] Settings saved");
                        }
                    }
                }
                // Exit - triggered when event loop is exiting (including macOS Command+Q)
                tauri::RunEvent::Exit => {
                    println!("[Exit] Event loop exiting, clearing autoFlip.active");
                    let settings = settings::get_settings(app_handle.clone());
                    if let Some(auto_flip) = settings.get("autoFlip").and_then(|v| v.as_object()) {
                        if auto_flip.get("active").and_then(|a| a.as_bool()).unwrap_or(false) {
                            let update = serde_json::json!({
                                "autoFlip": {
                                    "active": false,
                                    "interval": auto_flip.get("interval").and_then(|i| i.as_i64()).unwrap_or(30),
                                    "keepAwake": auto_flip.get("keepAwake").and_then(|k| k.as_bool()).unwrap_or(true)
                                }
                            });
                            println!("[Exit] Saving updated settings: {}", serde_json::to_string(&update).unwrap_or_else(|_| "Error".to_string()));
                            settings::save_settings(app_handle.clone(), update, None);
                            println!("[Exit] Settings saved");
                        }
                    }
                }
                // WindowEvent - monitor for destroyed/close events
                tauri::RunEvent::WindowEvent { label, event, .. } => {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        println!("[WindowEvent] Window '{}' destroyed, clearing autoFlip.active", label);
                        let settings = settings::get_settings(app_handle.clone());
                        if let Some(auto_flip) = settings.get("autoFlip").and_then(|v| v.as_object()) {
                            if auto_flip.get("active").and_then(|a| a.as_bool()).unwrap_or(false) {
                                let update = serde_json::json!({
                                    "autoFlip": {
                                        "active": false,
                                        "interval": auto_flip.get("interval").and_then(|i| i.as_i64()).unwrap_or(30),
                                        "keepAwake": auto_flip.get("keepAwake").and_then(|k| k.as_bool()).unwrap_or(true)
                                    }
                                });
                                println!("[WindowEvent] Saving updated settings: {}", serde_json::to_string(&update).unwrap_or_else(|_| "Error".to_string()));
                                settings::save_settings(app_handle.clone(), update, None);
                                println!("[WindowEvent] Settings saved");
                            }
                        }
                    }
                }
                _ => {}
            }
        });
}
