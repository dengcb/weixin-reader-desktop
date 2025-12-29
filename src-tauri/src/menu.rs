use tauri::{
    menu::{Menu, MenuItem, Submenu, CheckMenuItem, PredefinedMenuItem},
    App, Emitter, Manager, Runtime, WebviewWindowBuilder, WebviewUrl
};
use tauri_plugin_opener::OpenerExt;

pub fn init<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    let handle = app.handle();

    // 1. App Menu (macOS only mostly)
    let about = MenuItem::with_id(handle, "about", "关于", true, None::<&str>)?;
    let check_update = MenuItem::with_id(handle, "check_update", "检查更新...", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "设置...", true, Some("CmdOrCtrl+,"))?;
    
    let hide = PredefinedMenuItem::hide(handle, Some("隐藏"))?;
    let hide_others = PredefinedMenuItem::hide_others(handle, Some("隐藏其他"))?;
    let show_all = PredefinedMenuItem::show_all(handle, Some("显示全部"))?;
    let quit = PredefinedMenuItem::quit(handle, Some("退出"))?;

    let app_menu = Submenu::with_items(
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
    )?;
    
    // 2. View Menu
    let refresh = MenuItem::with_id(handle, "refresh", "刷新", true, Some("CmdOrCtrl+R"))?;
    let back = MenuItem::with_id(handle, "back", "后退", true, Some("CmdOrCtrl+["))?;
    let forward = MenuItem::with_id(handle, "forward", "前进", true, Some("CmdOrCtrl+]"))?;
    
    let auto_flip = CheckMenuItem::with_id(handle, "auto_flip", "自动翻页", true, false, Some("CmdOrCtrl+I"))?;
    
    let zoom_reset = MenuItem::with_id(handle, "zoom_reset", "实际大小", true, Some("CmdOrCtrl+0"))?;
    let zoom_in = MenuItem::with_id(handle, "zoom_in", "放大", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(handle, "zoom_out", "缩小", true, Some("CmdOrCtrl+-"))?;
    
    // Native macOS Fullscreen MenuItem
    // Using PredefinedMenuItem::fullscreen automatically binds to the system's "Enter Full Screen" action.
    // This allows macOS to handle the shortcuts (Fn+F, Ctrl+Cmd+F) natively and show the correct icon/text in the menu.
    let toggle_fullscreen = PredefinedMenuItem::fullscreen(handle, Some("切换全屏"))?;
    
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
                    let _ = win.emit("menu-action", "zoom_in");
                }
            }
            "zoom_out" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "zoom_out");
                }
            }
            "zoom_reset" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("menu-action", "zoom_reset");
                }
            }
            "about" => {
                if let Some(win) = app.get_webview_window("about") {
                    let _ = win.set_focus();
                } else {
                     let _ = WebviewWindowBuilder::new(app, "about", WebviewUrl::App("about.html".into()))
                        .title("关于")
                        .inner_size(400.0, 300.0)
                        .center()
                        .resizable(false)
                        .build();
                }
            }
            "check_update" => {
                if let Some(win) = app.get_webview_window("update") {
                    let _ = win.set_focus();
                } else {
                    let win = WebviewWindowBuilder::new(app, "update", WebviewUrl::App("update.html".into()))
                        .title("检查更新")
                        .inner_size(400.0, 300.0)
                        .center()
                        .resizable(false)
                        .decorations(false)
                        .build();

                    if let Ok(w) = win {
                        let _ = w.set_shadow(true);
                    }
                }
            }
            "settings" => {
                if let Some(win) = app.get_webview_window("settings") {
                    let _ = win.set_focus();
                } else {
                     let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
                        .title("设置")
                        .inner_size(400.0, 300.0)
                        .center()
                        .resizable(false)
                        .build();
                }
            }
            // "toggle_fullscreen" event is handled natively by PredefinedMenuItem
            _ => {}
        }
    });

    Ok(())
}
