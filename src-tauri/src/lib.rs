use tauri::{WebviewUrl, WebviewWindowBuilder};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

mod menu;
mod settings;
mod commands;

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
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            // Menu Init
            menu::init(app)?;

            // Create Main Window
            let mut url = WebviewUrl::App("index.html".into());
            
            // Network check: Try to connect to weread.qq.com
            // If success, load remote URL directly
            // If fail, fallback to local index.html (which shows error UI)
            if check_network_connection() {
                url = WebviewUrl::External("https://weread.qq.com/".parse().unwrap());
            }

            let app_name = app.config().product_name.clone().unwrap_or("微信阅读".to_string());

            let _win = WebviewWindowBuilder::new(app, "main", url)
                .title(&app_name)
                .inner_size(1280.0, 800.0)
                .center()
                .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36")
                .initialization_script(inject_script)
                .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::update_menu_state,
            commands::set_menu_item_enabled,
            settings::get_settings,
            settings::save_settings,
            commands::set_zoom,
            commands::close_window,
            commands::set_title,
            commands::get_app_name,
            commands::get_app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
