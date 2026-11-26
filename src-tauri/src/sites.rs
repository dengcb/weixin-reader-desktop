use crate::plugin_manager;
use regex::Regex;
use tauri::{AppHandle, Runtime};

/// `enabledPlugins` 缺省表示全部启用，保持旧版设置文件的兼容性。
/// 一旦该列表存在，只有显式列出的在线站点可以被打开或出现在书店菜单中。
pub fn is_site_enabled(settings: &serde_json::Value, site_id: &str) -> bool {
    settings
        .get("global")
        .and_then(|global| global.get("enabledPlugins"))
        .and_then(serde_json::Value::as_array)
        .is_none_or(|ids| ids.iter().any(|value| value.as_str() == Some(site_id)))
}

/// 在线来源展示顺序（`global.siteOrder`，设置页拖拽写入的插件 id 有序数组）。
///
/// 插件目录枚举顺序在 APFS 上不稳定，菜单、⌘1~7 快捷键与设置页列表都必须
/// 经过这里排序：已列出的 id 按列表位置排前，未列出的追加在后并按 id 字母序
/// 兜底，保证任何一次枚举都能得到确定的展示顺序。
pub fn sort_plugins_by_site_order(
    settings: &serde_json::Value,
    plugins: &mut [plugin_manager::PluginInfo],
) {
    let order: Vec<&str> = settings
        .get("global")
        .and_then(|global| global.get("siteOrder"))
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect()
        })
        .unwrap_or_default();
    let rank: std::collections::HashMap<&str, usize> = order
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect();
    plugins.sort_by(|a, b| {
        let rank_a = rank.get(a.id.as_str()).copied().unwrap_or(usize::MAX);
        let rank_b = rank.get(b.id.as_str()).copied().unwrap_or(usize::MAX);
        let pinned = |plugin: &plugin_manager::PluginInfo| {
            plugin
                .capabilities
                .as_ref()
                .and_then(|caps| caps.get("fixedFirst"))
                .and_then(|value| value.as_bool())
                == Some(true)
        };
        pinned(b)
            .cmp(&pinned(a))
            .then_with(|| rank_a.cmp(&rank_b))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// 菜单、⌘1~7 快捷键与书城切换浮层共用的有序站点条目。
#[derive(Debug, Clone, PartialEq)]
pub struct EnabledSiteEntry {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub home_url: String,
}

/// 所有入口共用同一份有序启用来源。
pub fn ordered_enabled_sites(
    settings: &serde_json::Value,
    plugins: &mut [plugin_manager::PluginInfo],
) -> Vec<EnabledSiteEntry> {
    let mut entries = Vec::new();
    sort_plugins_by_site_order(settings, plugins);
    for plugin in plugins.iter() {
        let Some(site) = plugin.site.as_ref() else {
            continue;
        };
        if !is_site_enabled(settings, &plugin.id) {
            continue;
        }
        entries.push(EnabledSiteEntry {
            id: plugin.id.clone(),
            name: plugin.name.clone(),
            icon: plugin.icon.clone(),
            home_url: site.home_url.clone(),
        });
    }
    entries
}

fn resolve_plugin_home_url(
    plugins: impl IntoIterator<Item = plugin_manager::PluginInfo>,
    site_id: &str,
) -> Option<String> {
    plugins
        .into_iter()
        .find(|plugin| plugin.id == site_id)
        .and_then(|plugin| plugin.site.map(|site| site.home_url))
}

/// 根据 siteId 解析站点首页 URL
/// 从已安装插件的 manifest.site.home_url 匹配获取
///
/// 返回 None 表示未找到该站点
pub fn resolve_home_url<R: Runtime>(app: &AppHandle<R>, site_id: &str) -> Option<String> {
    plugin_manager::get_installed_plugins(app)
        .ok()
        .and_then(|plugins| resolve_plugin_home_url(plugins, site_id))
}

/// 根据 siteId 解析书架页 URL：插件 manifest.site.shelf 优先，未配置时回退首页 URL，保证「回书架」永远有落点。
pub fn resolve_shelf_url<R: Runtime>(app: &AppHandle<R>, site_id: &str) -> Option<String> {
    plugin_manager::get_installed_plugins(app)
        .ok()
        .and_then(|plugins| {
            plugins
                .iter()
                .find(|plugin| plugin.id == site_id)
                .and_then(|plugin| plugin.site.as_ref().and_then(|site| site.shelf.clone()))
                .filter(|shelf| !shelf.trim().is_empty())
                .or_else(|| resolve_plugin_home_url(plugins, site_id))
        })
}

/// 全局「默认页面」偏好：非正文退出后的回退落点（home=书城首页，shelf=书架）。
/// 缺失/非法值一律按 home 处理，与默认设置一致。
pub fn default_page_prefers_shelf(settings: &serde_json::Value) -> bool {
    settings
        .get("global")
        .and_then(|global| global.get("defaultPage"))
        .and_then(serde_json::Value::as_str)
        == Some("shelf")
}

/// 根据 siteId 解析「默认页面」：上次不是从图书正文退出时，启动/切换书店
/// 应回到的落点。设置 shelf 时书架未配置的站点经 resolve_shelf_url 回退首页。
pub fn resolve_default_page_url<R: Runtime>(app: &AppHandle<R>, site_id: &str) -> Option<String> {
    let prefers_shelf = crate::settings::read_settings(app)
        .as_ref()
        .map(default_page_prefers_shelf)
        .unwrap_or(false);
    if prefers_shelf {
        resolve_shelf_url(app, site_id)
    } else {
        resolve_home_url(app, site_id)
    }
}

fn host_matches_domain(host: &str, domain: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let domain = domain
        .trim()
        .trim_start_matches('.')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// manifest 的 reader_pattern 契约是「字符串或正则」。优先按正则解释；
/// 编译失败再退回子串匹配，兼容番茄 "/reader/" 这类朴素 pattern。
/// 番茄/起点/七猫的 pattern 均为正则（如 `/chapter/\d+/\d+`），
/// 子串匹配永远命不中，会把合法阅读页误判成非阅读页。
fn reader_path_matches(path: &str, pattern: &str) -> bool {
    match Regex::new(pattern) {
        Ok(re) => re.is_match(path),
        Err(_) => path.contains(pattern),
    }
}

/// 原生端对阅读页的最小权威判定。前端可报告更细能力，但不能把首页或未知域名
/// 自行升级成阅读上下文。
pub fn is_reader_url<R: Runtime>(app: &AppHandle<R>, url: &tauri::Url) -> bool {
    if url.scheme() == "atreader" || url.host_str() == Some("atreader.localhost") {
        return url.path() == "/local-reader";
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    plugin_manager::get_installed_plugins(app)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|plugin| plugin.site)
        .any(|site| {
            let domain_matches = match site.domain {
                serde_json::Value::String(domain) => host_matches_domain(host, &domain),
                serde_json::Value::Array(domains) => domains.iter().any(|domain| {
                    domain
                        .as_str()
                        .is_some_and(|domain| host_matches_domain(host, domain))
                }),
                _ => false,
            };
            domain_matches && reader_path_matches(url.path(), &site.reader_pattern)
        })
}

pub fn reader_action_supported<R: Runtime>(
    app: &AppHandle<R>,
    url: &tauri::Url,
    action: &str,
) -> bool {
    if !is_reader_url(app, url) {
        return false;
    }
    let Some(host) = url.host_str() else {
        // 自定义协议本地阅读器的能力由内置 manifest 固定提供。
        return true;
    };
    // 本地阅读页两种平台形态：Windows http://atreader.localhost、
    // macOS atreader://localhost（host 是 localhost 而非 None，不能落入
    // 下方按站点域名的查找——本地插件无 site 配置，会全部误判为不支持）。
    if host == "atreader.localhost" || (url.scheme() == "atreader" && host == "localhost") {
        return true;
    }
    let capability = match action {
        "reader_wide" => Some("wideMode"),
        "hide_toolbar" => Some("hideToolbar"),
        "hide_navbar" => Some("hideNavbar"),
        "hide_cursor" => Some("hideCursor"),
        "auto_flip" => Some("autoFlip"),
        "reader_prev_chapter" | "reader_next_chapter" => Some("chapterNav"),
        "reader_prev_page" | "reader_next_page" | "reader_style" => None,
        _ => return false,
    };
    let Some(capability) = capability else {
        return true;
    };
    plugin_manager::get_installed_plugins(app)
        .unwrap_or_default()
        .into_iter()
        .find(|plugin| {
            plugin.site.as_ref().is_some_and(|site| match &site.domain {
                serde_json::Value::String(domain) => host_matches_domain(host, domain),
                serde_json::Value::Array(domains) => domains.iter().any(|domain| {
                    domain
                        .as_str()
                        .is_some_and(|domain| host_matches_domain(host, domain))
                }),
                _ => false,
            })
        })
        .and_then(|plugin| plugin.capabilities)
        .and_then(|capabilities| {
            capabilities
                .get(capability)
                .and_then(serde_json::Value::as_bool)
        })
        == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plugin(id: &str, home_url: &str, with_site: bool) -> plugin_manager::PluginInfo {
        plugin_manager::PluginInfo {
            id: id.to_string(),
            name: id.to_string(),
            version: "1.0.0".to_string(),
            description: None,
            author: None,
            homepage: None,
            icon: None,
            source_type: "web".to_string(),
            site: with_site.then(|| plugin_manager::PluginSiteConfig {
                domain: json!("example.com"),
                home_url: home_url.to_string(),
                shelf: None,
                reader_pattern: "/reader/".to_string(),
                boot_theme: None,
            }),
            capabilities: None,
            config_schema: None,
            builtin: false,
            enabled: true,
        }
    }

    #[test]
    fn enabled_site_list_is_opt_in_only_when_present() {
        assert!(is_site_enabled(&json!({}), "weread"));
        let settings = json!({ "global": { "enabledPlugins": ["fanqie"] } });
        assert!(!is_site_enabled(&settings, "weread"));
        assert!(is_site_enabled(&settings, "fanqie"));
    }

    #[test]
    fn site_order_sorts_listed_ids_first_then_unknown_by_id() {
        let settings = json!({ "global": { "siteOrder": ["zread", "qimao"] } });
        let mut plugins = vec![
            plugin("qidian", "https://qidian.example/", true),
            plugin("fanqie", "https://fanqie.example/", true),
            plugin("zread", "https://zread.example/", true),
            plugin("qimao", "https://qimao.example/", true),
        ];
        sort_plugins_by_site_order(&settings, &mut plugins);
        let ids: Vec<&str> = plugins.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["zread", "qimao", "fanqie", "qidian"]);
    }

    #[test]
    fn default_page_prefers_shelf_only_for_explicit_shelf_value() {
        assert!(default_page_prefers_shelf(&json!({
            "global": { "defaultPage": "shelf" }
        })));
        // 缺失、home、非法值一律按首页处理
        assert!(!default_page_prefers_shelf(&json!({})));
        assert!(!default_page_prefers_shelf(&json!({
            "global": { "defaultPage": "home" }
        })));
        assert!(!default_page_prefers_shelf(&json!({
            "global": { "defaultPage": 42 }
        })));
    }

    #[test]
    fn site_order_is_id_sorted_when_setting_absent() {
        let mut plugins = vec![
            plugin("zread", "https://zread.example/", true),
            plugin("qimao", "https://qimao.example/", true),
            plugin("fanqie", "https://fanqie.example/", true),
        ];
        sort_plugins_by_site_order(&json!({}), &mut plugins);
        let ids: Vec<&str> = plugins.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["fanqie", "qimao", "zread"]);
    }

    #[test]
    fn ordered_sites_put_weread_first_and_honor_site_order() {
        let settings = json!({ "global": { "siteOrder": ["zread", "qimao"] } });
        let mut plugins = vec![
            plugin("qidian", "https://qidian.example/", true),
            plugin("zread", "https://zread.example/", true),
            plugin("qimao", "https://qimao.example/", true),
        ];
        let mut fixed = plugin("weread", "https://weread.qq.com/", true);
        fixed.capabilities = Some(json!({"fixedFirst": true}));
        fixed.name = "微信读书".into();
        fixed.icon = Some("data:image/png;base64,abc".into());
        plugins.push(fixed);
        let entries = ordered_enabled_sites(&settings, &mut plugins);
        let ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, vec!["weread", "zread", "qimao", "qidian"]);
        assert_eq!(entries[0].name, "微信读书");
        assert_eq!(entries[0].home_url, "https://weread.qq.com/");
        assert!(entries[0]
            .icon
            .as_deref()
            .is_some_and(|icon| icon.starts_with("data:image/png;base64,")));
    }

    #[test]
    fn ordered_sites_filter_disabled_and_siteless_plugins() {
        let settings = json!({ "global": { "enabledPlugins": ["fanqie"] } });
        let mut plugins = vec![
            plugin("fanqie", "https://fanqie.example/", true),
            plugin("qimao", "https://qimao.example/", true),
            plugin("siteless", "https://unused.example/", false),
        ];
        let entries = ordered_enabled_sites(&settings, &mut plugins);
        let ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, vec!["fanqie"]);
    }

    #[test]
    fn ordered_sites_are_empty_without_plugins() {
        let entries = ordered_enabled_sites(&json!({}), &mut []);
        assert!(entries.is_empty());
        let settings = json!({ "global": { "enabledPlugins": ["fanqie"] } });
        assert!(ordered_enabled_sites(&settings, &mut []).is_empty());
    }

    #[test]
    fn ordered_sites_carry_plugin_icon_through() {
        let mut fanqie = plugin("fanqie", "https://fanqie.example/", true);
        fanqie.icon = Some("data:image/png;base64,abc".to_string());
        let mut plugins = vec![fanqie];
        let settings = json!({ "global": { "enabledPlugins": ["fanqie"] } });
        let entries = ordered_enabled_sites(&settings, &mut plugins);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].icon.as_deref(),
            Some("data:image/png;base64,abc")
        );
    }

    #[test]
    fn plugin_home_resolution_selects_exact_id_and_requires_site_data() {
        let plugins = vec![
            plugin("first", "https://first.example/", true),
            plugin("without-site", "https://unused.example/", false),
            plugin("second", "https://second.example/", true),
        ];
        assert_eq!(
            resolve_plugin_home_url(plugins.clone(), "second"),
            Some("https://second.example/".to_string())
        );
        assert_eq!(
            resolve_plugin_home_url(plugins.clone(), "without-site"),
            None
        );
        assert_eq!(resolve_plugin_home_url(plugins, "missing"), None);
    }

    #[test]
    fn domain_matching_accepts_subdomains_but_rejects_confusable_suffixes() {
        assert!(host_matches_domain("weread.qq.com", "weread.qq.com"));
        assert!(host_matches_domain("book.weread.qq.com", "weread.qq.com"));
        assert!(host_matches_domain("BOOK.EXAMPLE.COM.", ".example.com"));
        assert!(!host_matches_domain("evilweread.qq.com", "weread.qq.com"));
        assert!(!host_matches_domain(
            "weread.qq.com.evil.test",
            "weread.qq.com"
        ));
    }

    #[test]
    fn reader_pattern_supports_regex_and_substring_fallback() {
        // 起点清单 pattern（正则）
        assert!(reader_path_matches(
            "/chapter/1034284970/717661163/",
            "/chapter/\\d+/\\d+"
        ));
        assert!(!reader_path_matches("/", "/chapter/\\d+/\\d+"));
        // 七猫清单 pattern（正则，两个分支都要能命中）
        let qimao = "/(reader/index/\\d+|shuku/\\d+-\\d+)";
        assert!(reader_path_matches("/reader/index/1655407/", qimao));
        assert!(reader_path_matches("/shuku/1655407-16480917400001/", qimao));
        assert!(!reader_path_matches("/book/1655407/", qimao));
        // 番茄清单 pattern（朴素子串，按正则解释语义相同）
        assert!(reader_path_matches("/reader/12345/", "/reader/"));
        assert!(!reader_path_matches("/review/12345/", "/reader/"));
        // 非法正则退回子串匹配
        assert!(reader_path_matches("/x/a(unclosed/y", "a(unclosed/y"));
        assert!(!reader_path_matches("/other", "a(unclosed/y"));
    }
}
