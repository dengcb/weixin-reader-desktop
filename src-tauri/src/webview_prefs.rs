//! macOS WebKit「欺诈/有害网站」红屏开关。
//!
//! WebKit 在导航时按站点域名查 Google Safe Browsing，命中即在窗口内渲染
//! 不可跳过的整页红屏。掌阅 pc.ireader.com 被整域标记，书城由用户显式
//! 添加、阅读器没有随机冲浪面，误报的代价（书城不可用）远大于放行的
//! 风险，故用 WKPreferences 私有键 `_fraudulentWebsiteWarningEnabled`
//! 关闭（macOS 10.15+ 引入；运行时探测选择器，缺失时保持系统默认）。
//! 非 macOS 平台为空实现。

use tauri::{Runtime, WebviewWindow};

#[cfg(target_os = "macos")]
pub fn disable_fraudulent_warning<R: Runtime>(win: &WebviewWindow<R>) {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};

    let result = win.with_webview(|pw| unsafe {
        let webview = pw.inner() as *mut AnyObject;
        if webview.is_null() {
            eprintln!("[WebKitPrefs] WKWebView is null, keep fraud warning");
            return;
        }
        let config: *mut AnyObject = msg_send![webview, configuration];
        let preferences: *mut AnyObject = msg_send![config, preferences];
        if preferences.is_null() {
            eprintln!("[WebKitPrefs] WKPreferences is null, keep fraud warning");
            return;
        }
        let responds: bool = msg_send![
            preferences,
            respondsToSelector: sel!(_setFraudulentWebsiteWarningEnabled:)
        ];
        if !responds {
            eprintln!("[WebKitPrefs] private preference unavailable on this macOS, keep default");
            return;
        }
        let _: () = msg_send![preferences, _setFraudulentWebsiteWarningEnabled: false];
        println!("[WebKitPrefs] fraudulent website warning disabled");
    });

    if let Err(e) = result {
        eprintln!("[WebKitPrefs] with_webview failed: {:?}", e);
    }
}

/// 非 macOS 平台：空实现（WebView2 默认不渲染 Safe Browsing 红屏）。
#[cfg(not(target_os = "macos"))]
pub fn disable_fraudulent_warning<R: Runtime>(_win: &WebviewWindow<R>) {}
