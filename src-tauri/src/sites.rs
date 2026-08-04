use crate::plugin_manager;
use tauri::{AppHandle, Runtime};

/// 站点配置结构体
/// 用于管理多个阅读网站的配置信息
#[derive(Debug, Clone)]
pub struct SiteConfig {
    /// 站点 ID (用于内部识别)
    pub id: &'static str,
    /// 站点首页 URL
    pub home_url: &'static str,
}

/// 微信读书配置
pub const WEREAD: SiteConfig = SiteConfig {
    id: "weread",
    home_url: "https://weread.qq.com/",
};

/// `enabledPlugins` 缺省表示全部启用，保持旧版设置文件的兼容性。
/// 一旦该列表存在，只有显式列出的在线站点可以被打开或出现在书店菜单中。
pub fn is_site_enabled(settings: &serde_json::Value, site_id: &str) -> bool {
    settings
        .get("global")
        .and_then(|global| global.get("enabledPlugins"))
        .and_then(serde_json::Value::as_array)
        .is_none_or(|ids| ids.iter().any(|value| value.as_str() == Some(site_id)))
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
/// - 内置站点 weread 直接返回常量
/// - 其它 id 从已安装外部插件的 manifest.site.home_url 匹配获取
///
/// 返回 None 表示未找到该站点
pub fn resolve_home_url<R: Runtime>(app: &AppHandle<R>, site_id: &str) -> Option<String> {
    if site_id == WEREAD.id {
        return Some(WEREAD.home_url.to_string());
    }
    plugin_manager::get_installed_plugins(app)
        .ok()
        .and_then(|plugins| resolve_plugin_home_url(plugins, site_id))
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
                reader_pattern: "/reader/".to_string(),
            }),
            capabilities: None,
            config_schema: None,
            builtin: false,
            enabled: true,
        }
    }

    #[test]
    fn built_in_site_contract_is_stable() {
        assert_eq!(WEREAD.id, "weread");
        assert_eq!(WEREAD.home_url, "https://weread.qq.com/");
    }

    #[test]
    fn enabled_site_list_is_opt_in_only_when_present() {
        assert!(is_site_enabled(&json!({}), "weread"));
        let settings = json!({ "global": { "enabledPlugins": ["fanqie"] } });
        assert!(!is_site_enabled(&settings, "weread"));
        assert!(is_site_enabled(&settings, "fanqie"));
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
}
