use crate::{commands, plugin_manager};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct PendingPluginInstallState {
    pending: Mutex<Option<PendingPluginInstall>>,
}

#[derive(Clone)]
struct PendingPluginInstall {
    path: PathBuf,
    preview: PluginInstallPreview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallPreview {
    pub token: String,
    pub file_name: String,
    pub file_size: u64,
    pub plugin: plugin_manager::PluginInfo,
    pub domains: Vec<String>,
    pub icon_url: Option<String>,
    pub favicon_url: Option<String>,
    pub conflicts: Vec<plugin_manager::PluginInstallConflict>,
    pub can_install: bool,
    pub replaces_existing: bool,
}

fn safe_icon_url(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    const SAFE_DATA_IMAGE_PREFIXES: &[&str] = &[
        "data:image/png",
        "data:image/jpeg",
        "data:image/webp",
        "data:image/gif",
        "data:image/x-icon",
        "data:image/vnd.microsoft.icon",
    ];
    if SAFE_DATA_IMAGE_PREFIXES
        .iter()
        .any(|prefix| value.starts_with(prefix))
    {
        return Some(value.to_string());
    }
    let url = tauri::Url::parse(value).ok()?;
    matches!(url.scheme(), "https" | "http").then(|| url.to_string())
}

fn favicon_url(manifest: &plugin_manager::PluginInfo) -> Option<String> {
    let home = manifest.site.as_ref()?.home_url.as_str();
    let mut url = tauri::Url::parse(home).ok()?;
    url.set_path("/favicon.ico");
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn build_preview(app: &AppHandle, path: &Path) -> Result<PluginInstallPreview, String> {
    let path_string = path.to_string_lossy();
    let manifest = plugin_manager::inspect_plugin_package(&path_string)?;
    let conflicts = plugin_manager::get_install_conflicts(app, &manifest)?;
    let metadata =
        fs::metadata(path).map_err(|error| format!("Failed to inspect plugin package: {error}"))?;
    let token = format!(
        "{}-{}",
        std::process::id(),
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("plugin.atrd")
        .to_string();
    let can_install = !conflicts.iter().any(|conflict| conflict.blocking);
    let replaces_existing = conflicts
        .iter()
        .any(|conflict| conflict.kind == "existing-id");
    Ok(PluginInstallPreview {
        token,
        file_name,
        file_size: metadata.len(),
        domains: plugin_manager::manifest_domains(&manifest),
        icon_url: safe_icon_url(manifest.icon.as_deref()),
        favicon_url: favicon_url(&manifest),
        plugin: manifest,
        conflicts,
        can_install,
        replaces_existing,
    })
}

fn show_install_window(app: &AppHandle, preview: &PluginInstallPreview) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("plugin-installer") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        window
            .emit("plugin-install-preview-updated", preview)
            .map_err(|error| format!("Failed to update plugin installer window: {error}"))?;
        return Ok(());
    }

    let url = format!("plugin-installer.html?token={}", preview.token);
    WebviewWindowBuilder::new(app, "plugin-installer", WebviewUrl::App(url.into()))
        .title("安装插件 · 艾特阅读")
        .inner_size(620.0, 720.0)
        .min_inner_size(560.0, 640.0)
        .center()
        .resizable(true)
        .build()
        .map_err(|error| format!("Failed to open plugin installer window: {error}"))?;
    Ok(())
}

pub fn request_plugin_install(app: &AppHandle, path: &Path) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve plugin package path: {error}"))?;
    let preview = build_preview(app, &canonical)?;
    let pending = PendingPluginInstall {
        path: canonical,
        preview: preview.clone(),
    };
    let state = app.state::<PendingPluginInstallState>();
    *state
        .pending
        .lock()
        .map_err(|_| "Plugin installer state is unavailable".to_string())? = Some(pending);
    show_install_window(app, &preview)
}

/// macOS 冷启动时 Opened 事件可能先于主窗口 setup 到达；主窗口创建后再次
/// 聚焦待确认窗口，避免用户双击插件包却只看到阅读主窗口。
pub fn focus_pending_plugin_install(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<PendingPluginInstallState>();
    let preview = state
        .pending
        .lock()
        .map_err(|_| "Plugin installer state is unavailable".to_string())?
        .as_ref()
        .map(|pending| pending.preview.clone());
    if let Some(preview) = preview {
        show_install_window(app, &preview)?;
    }
    Ok(())
}

fn path_from_argument(argument: &str, cwd: &Path) -> Option<PathBuf> {
    let value = argument.trim();
    let raw = if value.starts_with("file://") {
        tauri::Url::parse(value).ok()?.to_file_path().ok()?
    } else {
        PathBuf::from(value)
    };
    let path = if raw.is_absolute() {
        raw
    } else {
        cwd.join(raw)
    };
    let is_atrd = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("atrd"));
    is_atrd.then_some(path)
}

pub fn handle_external_arguments(app: &AppHandle, arguments: &[String], cwd: &Path) {
    let Some(path) = arguments
        .iter()
        .find_map(|argument| path_from_argument(argument, cwd))
    else {
        return;
    };
    if let Err(error) = request_plugin_install(app, &path) {
        app.dialog()
            .message(format!("无法打开插件包：\n{error}"))
            .title("插件安装失败")
            .kind(MessageDialogKind::Error)
            .show(|_| {});
    }
}

pub fn handle_opened_urls(app: &AppHandle, urls: &[tauri::Url]) {
    let Some(path) = urls.iter().find_map(|url| {
        (url.scheme() == "file")
            .then(|| url.to_file_path().ok())
            .flatten()
            .filter(|path| {
                path.extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("atrd"))
            })
    }) else {
        return;
    };
    if let Err(error) = request_plugin_install(app, &path) {
        app.dialog()
            .message(format!("无法打开插件包：\n{error}"))
            .title("插件安装失败")
            .kind(MessageDialogKind::Error)
            .show(|_| {});
    }
}

#[tauri::command]
pub async fn prepare_plugin_install(app: AppHandle, path: String) -> Result<(), String> {
    request_plugin_install(&app, Path::new(&path))
}

#[tauri::command]
pub async fn get_pending_plugin_install(app: AppHandle) -> Result<PluginInstallPreview, String> {
    let state = app.state::<PendingPluginInstallState>();
    let preview = state
        .pending
        .lock()
        .map_err(|_| "Plugin installer state is unavailable".to_string())?
        .as_ref()
        .map(|pending| pending.preview.clone())
        .ok_or_else(|| "没有待安装的插件".to_string())?;
    Ok(preview)
}

#[tauri::command]
pub async fn cancel_pending_plugin_install(app: AppHandle, token: String) -> Result<(), String> {
    let state = app.state::<PendingPluginInstallState>();
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "Plugin installer state is unavailable".to_string())?;
    if pending
        .as_ref()
        .is_some_and(|request| request.preview.token == token)
    {
        *pending = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn confirm_pending_plugin_install(
    app: AppHandle,
    token: String,
) -> Result<plugin_manager::PluginInfo, String> {
    let request = {
        let state = app.state::<PendingPluginInstallState>();
        let pending = state
            .pending
            .lock()
            .map_err(|_| "Plugin installer state is unavailable".to_string())?;
        let request = pending
            .as_ref()
            .ok_or_else(|| "没有待安装的插件".to_string())?;
        if request.preview.token != token {
            return Err("安装请求已更新，请重新确认插件信息".to_string());
        }
        request.clone()
    };

    let path_string = request.path.to_string_lossy();
    let manifest = plugin_manager::inspect_plugin_package(&path_string)?;
    let conflicts = plugin_manager::get_install_conflicts(&app, &manifest)?;
    plugin_manager::reject_blocking_install_conflicts(&conflicts)?;

    let installed = plugin_manager::install_plugin_from_file(&app, &path_string)?;
    commands::enable_plugin_in_settings(&app, &installed.id)?;
    {
        let state = app.state::<PendingPluginInstallState>();
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "Plugin installer state is unavailable".to_string())?;
        if pending
            .as_ref()
            .is_some_and(|pending| pending.preview.token == token)
        {
            *pending = None;
        }
    }
    let _ = app.emit("plugins-updated", ());
    commands::refresh_app_menu(&app);
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_argument_accepts_only_atrd_paths() {
        let cwd = Path::new("/tmp/plugin-tests");
        assert_eq!(
            path_from_argument("fanqie.atrd", cwd),
            Some(cwd.join("fanqie.atrd"))
        );
        assert_eq!(
            path_from_argument("FANQIE.ATRD", cwd),
            Some(cwd.join("FANQIE.ATRD"))
        );
        assert_eq!(
            path_from_argument("file:///tmp/%E7%95%AA%E8%8C%84.atrd", cwd),
            Some(PathBuf::from("/tmp/番茄.atrd"))
        );
        assert_eq!(path_from_argument("notes.txt", cwd), None);
    }

    #[test]
    fn icon_urls_accept_images_and_http_only() {
        assert!(safe_icon_url(Some("data:image/png;base64,AAAA")).is_some());
        assert!(safe_icon_url(Some("https://example.com/icon.png")).is_some());
        assert!(safe_icon_url(Some("data:image/svg+xml,<svg/>")).is_none());
        assert!(safe_icon_url(Some("javascript:alert(1)")).is_none());
        assert!(safe_icon_url(Some("file:///tmp/icon.png")).is_none());
    }
}
