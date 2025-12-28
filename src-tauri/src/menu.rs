use tauri::{
    menu::{Menu, MenuItem, Submenu, CheckMenuItem, PredefinedMenuItem},
    App, Emitter, Manager, Runtime
};
use tauri_plugin_opener::OpenerExt;

pub fn init<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    let handle = app.handle();

    // 1. App Menu (macOS only mostly)
    let app_menu = Submenu::new(
        handle,
        "App",
        true,
    )?;
    
    // 2. View Menu
    let refresh = MenuItem::with_id(handle, "refresh", "刷新", true, Some("CmdOrCtrl+R"))?;
    let back = MenuItem::with_id(handle, "back", "后退", true, Some("CmdOrCtrl+["))?;
    let forward = MenuItem::with_id(handle, "forward", "前进", true, Some("CmdOrCtrl+]"))?;
    
    let auto_flip = CheckMenuItem::with_id(handle, "auto_flip", "自动翻页", true, false, Some("CmdOrCtrl+I"))?;
    
    let zoom_reset = MenuItem::with_id(handle, "zoom_reset", "实际大小", true, Some("CmdOrCtrl+0"))?;
    let zoom_in = MenuItem::with_id(handle, "zoom_in", "放大", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(handle, "zoom_out", "缩小", true, Some("CmdOrCtrl+-"))?;
    
    // Check if fullscreen is predefined
    // PredefinedMenuItem::fullscreen is NOT in list. Use custom.
    let toggle_fullscreen = MenuItem::with_id(handle, "toggle_fullscreen", "切换全屏", true, Some("Ctrl+Cmd+F"))?;
    
    let reader_wide = CheckMenuItem::with_id(handle, "reader_wide", "阅读变宽", true, false, Some("CmdOrCtrl+9"))?;
    let hide_toolbar = CheckMenuItem::with_id(handle, "hide_toolbar", "隐藏工具栏", true, false, Some("CmdOrCtrl+O"))?;
    
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
        ],
    )?;

    // 3. Window Menu
    let minimize = PredefinedMenuItem::minimize(handle, Some("最小化"))?;
    let window_menu = Submenu::with_items(
        handle,
        "窗口",
        true,
        &[
            &minimize,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, Some("关闭"))?,
        ]
    )?;

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

    // Event Handling
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
            "auto_flip" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "auto_flip");
                }
            }
            "zoom_in" => {
                if let Some(win) = app.get_webview_window("main") {
                    // Primitive zoom
                     let _ = win.eval("document.body.style.zoom = (parseFloat(document.body.style.zoom || 1) + 0.1)");
                }
            }
            "zoom_out" => {
                if let Some(win) = app.get_webview_window("main") {
                     let _ = win.eval("document.body.style.zoom = (parseFloat(document.body.style.zoom || 1) - 0.1)");
                }
            }
            "zoom_reset" => {
                if let Some(win) = app.get_webview_window("main") {
                     let _ = win.eval("document.body.style.zoom = 1");
                }
            }
            "toggle_fullscreen" => {
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(is_fs) = win.is_fullscreen() {
                        let _ = win.set_fullscreen(!is_fs);
                    }
                }
            }
            _ => {}
        }
    });

    Ok(())
}
