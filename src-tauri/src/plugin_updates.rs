//! 外部插件在线更新：拉取仓库 `plugins/index.json` 版本索引并下载 `.atrd`。
//! 检查与下载都由 Rust（ureq）执行，设置窗口不直接访问网络。
//! 索引由 `build_plugin.ts` 从构建产物生成，禁止手工编辑。

use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::time::Duration;
use tauri::{AppHandle, Runtime};

use crate::plugin_manager;

/// 主源 raw.githubusercontent（与仓库实时同步）；备源 jsDelivr 镜像
/// （国内可达性更好，但缓存滞后数小时，仅作主源失败后的回退）。
/// 索引中的 atrd 路径为相对路径，按源基址拼接。
pub const UPDATE_BASES: [&str; 2] = [
    "https://raw.githubusercontent.com/dengcb/weixin-reader-desktop/main",
    "https://cdn.jsdelivr.net/gh/dengcb/weixin-reader-desktop@main",
];
const INDEX_PATH: &str = "/plugins/index.json";
const MAX_INDEX_BYTES: u64 = 256 * 1024;
/// 与安装器的包体积上限保持一致（plugin_manager 校验 20 MiB）。
const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateStatus {
    pub id: String,
    pub installed_version: String,
    pub remote_version: String,
    pub has_update: bool,
}

fn fetch_bytes(url: &str, max_bytes: u64, read_timeout: Duration) -> Result<Vec<u8>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(read_timeout)
        .build();
    let response = agent.get(url).call().map_err(|e| format!("请求失败：{e}"))?;
    let mut reader = response.into_reader().take(max_bytes + 1);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(|e| format!("读取失败：{e}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("内容超过大小上限（{max_bytes} 字节）"));
    }
    Ok(bytes)
}

/// 依次尝试主源与备源，任一成功即返回。
fn fetch_with_fallback(
    path: &str,
    max_bytes: u64,
    read_timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut last_error = String::new();
    for base in UPDATE_BASES {
        match fetch_bytes(&format!("{base}{path}"), max_bytes, read_timeout) {
            Ok(bytes) => return Ok(bytes),
            Err(e) => last_error = format!("{base}：{e}"),
        }
    }
    Err(format!("所有更新源均不可达。{last_error}"))
}

pub fn fetch_update_index() -> Result<Value, String> {
    let bytes = fetch_with_fallback(INDEX_PATH, MAX_INDEX_BYTES, Duration::from_secs(30))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("更新索引格式错误：{e}"))
}

/// 下载索引中登记的 .atrd 包（同样支持备源回退）。
pub fn download_package(atrd_path: &str) -> Result<Vec<u8>, String> {
    if !atrd_path.starts_with('/') {
        return Err("更新索引中的 atrd 路径必须以 / 开头".to_string());
    }
    fetch_with_fallback(atrd_path, MAX_PACKAGE_BYTES, Duration::from_secs(60))
}

/// x.y.z 版本比较：remote 严格大于 installed 才视为可更新。
/// 解析失败的版本一律不可更新（宁可不提示，不误报）。
pub fn is_newer_version(remote: &str, installed: &str) -> bool {
    match (parse_version(remote), parse_version(installed)) {
        (Some(r), Some(i)) => r > i,
        _ => false,
    }
}

fn parse_version(version: &str) -> Option<[u64; 3]> {
    let segments: Vec<&str> = version.trim().split('.').collect();
    if segments.len() != 3 {
        return None;
    }
    let mut parts = [0u64; 3];
    for (slot, segment) in parts.iter_mut().zip(segments) {
        *slot = segment.parse().ok()?;
    }
    Some(parts)
}

/// 对比已安装外部插件与远端索引。仅 Web 插件参与（内置站点随应用分发）；
/// 未收录进索引的已装插件静默跳过（如第三方手工安装的包）。
pub fn check_updates<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<PluginUpdateStatus>, String> {
    let installed = plugin_manager::get_installed_plugins(app)?;
    let index = fetch_update_index()?;
    let entries = index
        .as_object()
        .ok_or("更新索引格式错误：顶层应为对象")?;

    let mut result = Vec::new();
    for plugin in installed {
        if plugin.builtin || plugin.site.is_none() {
            continue;
        }
        let Some(entry) = entries.get(&plugin.id) else {
            continue;
        };
        let Some(remote_version) = entry.get("version").and_then(Value::as_str) else {
            continue;
        };
        result.push(PluginUpdateStatus {
            id: plugin.id.clone(),
            installed_version: plugin.version.clone(),
            remote_version: remote_version.to_string(),
            has_update: is_newer_version(remote_version, &plugin.version),
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_version_requires_strictly_greater() {
        assert!(is_newer_version("1.0.1", "1.0.0"));
        assert!(is_newer_version("1.1.0", "1.0.9"));
        assert!(is_newer_version("2.0.0", "1.99.99"));
        assert!(!is_newer_version("1.0.0", "1.0.0"));
        assert!(!is_newer_version("1.0.0", "1.0.1"));
    }

    #[test]
    fn malformed_versions_are_never_newer() {
        assert!(!is_newer_version("1.0", "1.0.0"));
        assert!(!is_newer_version("v1.0.0", "1.0.0"));
        assert!(!is_newer_version("1.0.0-beta", "1.0.0"));
        assert!(!is_newer_version("", "1.0.0"));
        assert!(!is_newer_version("1.0.0", "未知"));
    }
}
