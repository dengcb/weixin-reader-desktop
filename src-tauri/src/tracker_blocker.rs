//! Tracker 拦截器（macOS 原生 WKContentRuleList）
//!
//! 在 WKWebView 内拦截纯统计/追踪域名（如 hm.baidu.com），避免其同步阻塞脚本
//! 拖慢页面加载。永远开启；仅拦截统计/追踪域名，绝不拦内容 CDN。
//! 非 macOS 平台为空实现。

use tauri::{Runtime, WebviewWindow};

/// 保守黑名单：纯统计/追踪域名（host 精确锚定，避免误伤内容域名与 weread.qq.com）。
/// url-filter 为 WKContentRuleList 支持的正则，匹配资源 URL。
#[cfg(target_os = "macos")]
const RULES_JSON: &str = r#"[
  {"trigger":{"url-filter":"^https?://([a-z0-9-]+\\.)*hm\\.baidu\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([a-z0-9-]+\\.)*hmcdn\\.baidu\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([a-z0-9-]+\\.)*cnzz\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([a-z0-9-]+\\.)*mmstat\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([a-z0-9-]+\\.)*umeng\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([a-z0-9-]+\\.)*umeng\\.co[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([a-z0-9-]+\\.)*umtrack\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://([a-z0-9-]+\\.)*51\\.la[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://www\\.google-analytics\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://ssl\\.google-analytics\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://analytics\\.google\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://www\\.googletagmanager\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://tajs\\.qq\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://pingjs\\.qq\\.com[:/]"},"action":{"type":"block"}},
  {"trigger":{"url-filter":"^https?://mta\\.qq\\.com[:/]"},"action":{"type":"block"}}
]"#;

/// 安装 tracker 拦截规则到主窗口 WKWebView。
/// 非 macOS 平台不做任何事。
#[cfg(target_os = "macos")]
pub fn install<R: Runtime>(win: &WebviewWindow<R>) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    let result = win.with_webview(|pw| unsafe {
        // pw.controller() 返回 WKUserContentController 指针
        let ucc = pw.controller() as *mut AnyObject;
        if ucc.is_null() {
            eprintln!("[TrackerBlocker] userContentController is null, skip");
            return;
        }

        let store: *mut AnyObject = msg_send![class!(WKContentRuleListStore), defaultStore];
        if store.is_null() {
            eprintln!("[TrackerBlocker] WKContentRuleListStore.defaultStore is null, skip");
            return;
        }

        let ident = NSString::from_str("wxrd-tracker-block");
        let json = NSString::from_str(RULES_JSON);

        // 异步编译完成后挂载到 userContentController（回调在主线程执行）
        let ucc_addr = ucc as usize;
        let handler = RcBlock::new(move |list: *mut AnyObject, _err: *mut AnyObject| {
            if !list.is_null() {
                let ucc = ucc_addr as *mut AnyObject;
                let _: () = msg_send![ucc, addContentRuleList: list];
                println!("[TrackerBlocker] Content rule list installed");
            } else {
                eprintln!("[TrackerBlocker] Failed to compile rule list");
            }
        });

        let _: () = msg_send![
            store,
            compileContentRuleListForIdentifier: &*ident,
            encodedContentRuleList: &*json,
            completionHandler: &*handler,
        ];
    });

    if let Err(e) = result {
        eprintln!("[TrackerBlocker] with_webview failed: {:?}", e);
    }
}

/// 非 macOS 平台：空实现。
#[cfg(not(target_os = "macos"))]
pub fn install<R: Runtime>(_win: &WebviewWindow<R>) {}
