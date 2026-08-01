use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

#[tauri::command]
pub fn log_to_file(_app: AppHandle, message: String) {
    log::info!(target: "frontend", "{message}");
}

#[tauri::command]
pub fn update_menu_state(app: AppHandle, id: String, state: bool) {
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            // Item 1 is the View submenu
            if let Some(view_submenu) = items.get(1).and_then(|i| i.as_submenu()) {
                if let Ok(sub_items) = view_submenu.items() {
                    for sub_item in sub_items.iter() {
                        if *sub_item.id() == tauri::menu::MenuId::from(id.as_str()) {
                            if let Some(check_item) = sub_item.as_check_menuitem() {
                                let _ = check_item.set_checked(state);
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn set_menu_item_enabled(app: AppHandle, id: String, enabled: bool) {
    let mut found = false;
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            for menu_item in items.iter() {
                if let Some(submenu) = menu_item.as_submenu() {
                    if let Ok(sub_items) = submenu.items() {
                        for sub_item in sub_items.iter() {
                            if *sub_item.id() == tauri::menu::MenuId::from(id.as_str()) {
                                if let Some(check_item) = sub_item.as_check_menuitem() {
                                    let _ = check_item.set_enabled(enabled);
                                } else if let Some(menu_item_inner) = sub_item.as_menuitem() {
                                    let _ = menu_item_inner.set_enabled(enabled);
                                } else if let Some(sub) = sub_item.as_submenu() {
                                    let _ = sub.set_enabled(enabled);
                                }
                                found = true;
                                break;
                            }
                        }
                    }
                    if found {
                        break;
                    }
                }
            }
        }
    }

    if !found {
        eprintln!(
            "[Menu] set_menu_item_enabled: NOT FOUND - id={}, enabled={}",
            id, enabled
        );
    }
}

/// 设置当前活跃书店（书店菜单单选对勾）
/// 找到「书店」子菜单，将 site_id 对应项勾上、其余取消
#[tauri::command]
pub fn set_active_bookstore(app: AppHandle, site_id: String) {
    println!(
        "[Bookstore] set_active_bookstore called: site_id={}",
        site_id
    );
    let target = tauri::menu::MenuId::from(format!("switch_site_{}", site_id).as_str());
    let mut found_menus = 0;
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            for top in items.iter() {
                if let Some(submenu) = top.as_submenu() {
                    // 通过标题识别书店子菜单
                    if submenu.text().map(|t| t == "书店").unwrap_or(false) {
                        found_menus += 1;
                        if let Ok(sub_items) = submenu.items() {
                            for it in sub_items.iter() {
                                if let Some(check) = it.as_check_menuitem() {
                                    let want = *it.id() == target;
                                    let _ = check.set_checked(want);
                                    println!(
                                        "[Bookstore]   item={} -> checked={}",
                                        it.id().0,
                                        want
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    println!("[Bookstore] done, 书店 submenus found={}", found_menus);
}

#[tauri::command]
pub fn set_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

/// 前端注入脚本初始化完成时调用，通知 Rust 端按当前站点应用缩放
#[tauri::command]
pub fn apply_site_zoom(app: AppHandle, site_id: String) {
    let settings = crate::settings::read_settings(&app)
        .unwrap_or_else(|_| crate::settings::default_settings());
    let zoom = settings
        .get("sites")
        .and_then(|s| s.get(&site_id))
        .and_then(|s| s.get("zoom"))
        .and_then(|z| z.as_f64())
        .unwrap_or(0.75);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_zoom(zoom);
    }
}

#[tauri::command]
pub fn get_app_name<R: Runtime>(app: AppHandle<R>) -> String {
    app.config()
        .product_name
        .clone()
        .unwrap_or("艾特阅读".to_string())
}

#[tauri::command]
pub fn get_app_version<R: Runtime>(app: AppHandle<R>) -> String {
    app.config().version.clone().unwrap_or("0.1.0".to_string())
}

// ==================== 插件管理命令 ====================

use crate::plugin_manager;

/// 插件变更后重建应用菜单（使「书店」菜单随外部插件增减即时出现/消失）
/// rebuild_full_menu 仅在 macOS/Windows 存在，其它平台为空操作
fn refresh_app_menu(app: &AppHandle) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if let Err(e) = crate::menu::rebuild_full_menu(app) {
            eprintln!("[Menu] Failed to rebuild menu after plugin change: {:?}", e);
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = app;
}

/// 安装插件
#[tauri::command]
pub async fn install_plugin(
    app: AppHandle,
    path: String,
) -> Result<plugin_manager::PluginInfo, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    println!("[Plugin] Installing plugin from: {}", path);

    // 在询问覆盖前完成体积、路径、文件数和 manifest 校验。
    let manifest = plugin_manager::inspect_plugin_package(&path)?;

    // 检查是否已存在同名 ID 的插件
    let existing_plugin = plugin_manager::get_installed_plugins(&app)
        .ok()
        .and_then(|plugins| plugins.into_iter().find(|p| p.id == manifest.id));

    if let Some(existing) = existing_plugin {
        // 弹出确认对话框
        let message = format!(
            "已安装「{}」插件，继续安装将覆盖现有版本。\n\n是否继续？",
            existing.name
        );

        let confirmed = app
            .dialog()
            .message(&message)
            .title("插件已存在")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "继续安装".to_string(),
                "取消".to_string(),
            ))
            .kind(MessageDialogKind::Warning)
            .blocking_show_with_result();

        if confirmed != tauri_plugin_dialog::MessageDialogResult::Ok {
            return Err("用户取消安装".to_string());
        }
    }

    let result = plugin_manager::install_plugin_from_file(&app, &path)?;
    println!(
        "[Plugin] Plugin installed: {} v{}",
        result.id, result.version
    );

    // 触发设置更新事件，通知前端
    let _ = app.emit("plugins-updated", ());
    refresh_app_menu(&app);

    Ok(result)
}

/// 若主窗口当前停留在指定插件的站点上，先导航回微信读书（优先续读上次阅读页，无则首页）
/// 用于卸载前脱离该站点，避免卸载后滞留在无插件支撑、且无书店菜单可切换的页面上
fn navigate_home_if_on_plugin_site(app: &AppHandle, plugin_id: &str) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let Ok(url) = win.url() else { return };
    let Some(host) = url.host_str().map(|h| h.to_string()) else {
        return;
    };

    // 取该插件声明的域名列表（site.domain 可为 string 或 string[]）
    let domains: Vec<String> = plugin_manager::get_installed_plugins(app)
        .ok()
        .and_then(|list| list.into_iter().find(|p| p.id == plugin_id))
        .and_then(|p| p.site)
        .map(|s| match s.domain {
            serde_json::Value::String(d) => vec![d],
            serde_json::Value::Array(arr) => arr
                .into_iter()
                .filter_map(|v| v.as_str().map(|x| x.to_string()))
                .collect(),
            _ => vec![],
        })
        .unwrap_or_default();

    let on_site = domains
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{}", d)));
    if !on_site {
        return;
    }

    // 导航目标：weread 上次阅读页 → 回退 weread 首页
    let settings =
        crate::settings::read_settings(app).unwrap_or_else(|_| crate::settings::default_settings());
    let target = settings
        .get("sites")
        .and_then(|s| s.get("weread"))
        .and_then(|s| s.get("lastReaderUrl"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .or_else(|| crate::sites::resolve_home_url(app, "weread"));
    if let Some(t) = target {
        if let Ok(u) = t.parse::<tauri::Url>() {
            println!(
                "[Plugin] Main window is on '{}' site, navigating back to weread before uninstall",
                plugin_id
            );
            let _ = win.navigate(u);
        }
    }
}

/// 卸载插件
#[tauri::command]
pub async fn uninstall_plugin(app: AppHandle, plugin_id: String) -> Result<(), String> {
    println!("[Plugin] Uninstalling plugin: {}", plugin_id);
    // 若正停在该插件站点上，先跳回微信读书再卸载
    navigate_home_if_on_plugin_site(&app, &plugin_id);
    plugin_manager::uninstall_plugin(&app, &plugin_id)?;
    println!("[Plugin] Plugin uninstalled: {}", plugin_id);

    // 触发设置更新事件
    let _ = app.emit("plugins-updated", ());
    refresh_app_menu(&app);

    Ok(())
}

/// 获取已安装的插件列表
#[tauri::command]
pub async fn get_installed_plugins(
    app: AppHandle,
) -> Result<Vec<plugin_manager::PluginInfo>, String> {
    plugin_manager::get_installed_plugins(&app)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlugin {
    pub plugin: plugin_manager::PluginInfo,
    pub code: String,
}

fn manifest_matches_host(plugin: &plugin_manager::PluginInfo, host: &str) -> bool {
    plugin_manager::manifest_matches_host(plugin, host)
}

/// 主窗口只能取得与当前 URL 唯一匹配的插件代码。
#[tauri::command]
pub async fn get_runtime_plugin<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Option<RuntimePlugin>, String> {
    if window.label() != "main" {
        return Err("Runtime plugins are only available to the main window".to_string());
    }
    let url = window
        .url()
        .map_err(|error| format!("Failed to read window URL: {error}"))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Ok(None);
    }
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return Ok(None);
    };
    let settings = crate::settings::read_settings(&app)
        .unwrap_or_else(|_| crate::settings::default_settings());
    let enabled = settings
        .get("global")
        .and_then(|global| global.get("enabledPlugins"))
        .and_then(serde_json::Value::as_array);
    let is_enabled = |plugin_id: &str| {
        enabled.is_none_or(|ids| ids.iter().any(|value| value.as_str() == Some(plugin_id)))
    };

    let matches: Vec<_> = plugin_manager::get_installed_plugins(&app)?
        .into_iter()
        .filter(|plugin| is_enabled(&plugin.id) && manifest_matches_host(plugin, &host))
        .collect();
    if matches.len() > 1 {
        return Err("More than one installed plugin matches the current URL".to_string());
    }
    let Some(plugin) = matches.into_iter().next() else {
        return Ok(None);
    };
    let code = plugin_manager::get_plugin_code(&app, &plugin.id)?;
    Ok(Some(RuntimePlugin { plugin, code }))
}

// ==================== 插件编辑器命令 ====================

/// 插件文件数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginFile {
    pub name: String,
    pub content: String,
}

fn write_plugin_files(
    plugin_dir: &std::path::Path,
    manifest: &serde_json::Value,
    files: Vec<PluginFile>,
) -> Result<(), String> {
    const MAX_EDITOR_FILE_BYTES: usize = 4 * 1024 * 1024;
    const MAX_EDITOR_TOTAL_BYTES: usize = 20 * 1024 * 1024;
    if files.len() > 128 {
        return Err("Too many plugin files".to_string());
    }
    let mut total = 0usize;
    let mut names = std::collections::HashSet::new();
    for file in &files {
        plugin_manager::validate_plugin_file_name(&file.name)?;
        if !names.insert(file.name.clone()) {
            return Err(format!("Duplicate plugin file: {}", file.name));
        }
        if file.content.len() > MAX_EDITOR_FILE_BYTES {
            return Err(format!("Plugin file is too large: {}", file.name));
        }
        total = total.saturating_add(file.content.len());
    }
    if total > MAX_EDITOR_TOTAL_BYTES {
        return Err("Plugin files exceed the total size limit".to_string());
    }

    std::fs::create_dir_all(plugin_dir)
        .map_err(|error| format!("Failed to create plugin directory: {error}"))?;
    let root_metadata = std::fs::symlink_metadata(plugin_dir)
        .map_err(|error| format!("Failed to inspect plugin directory: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("Plugin directory must be a real directory".to_string());
    }

    let manifest_id = manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or("Missing plugin id in manifest")?;
    plugin_manager::validate_plugin_id(manifest_id)?;
    let manifest_path = plugin_dir.join("manifest.json");
    if std::fs::symlink_metadata(&manifest_path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Plugin manifest cannot be a symbolic link".to_string());
    }
    let manifest_string = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("Failed to serialize manifest: {error}"))?;
    std::fs::write(&manifest_path, manifest_string)
        .map_err(|error| format!("Failed to write manifest: {error}"))?;

    for file in files {
        let file_path = if file.name.ends_with(".css") {
            let styles_dir = plugin_dir.join("styles");
            std::fs::create_dir_all(&styles_dir)
                .map_err(|error| format!("Failed to create styles directory: {error}"))?;
            if std::fs::symlink_metadata(&styles_dir)
                .is_ok_and(|meta| meta.file_type().is_symlink())
            {
                return Err("Plugin styles directory cannot be a symbolic link".to_string());
            }
            styles_dir.join(&file.name)
        } else {
            plugin_dir.join(&file.name)
        };
        if std::fs::symlink_metadata(&file_path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(format!(
                "Plugin file cannot be a symbolic link: {}",
                file.name
            ));
        }
        std::fs::write(&file_path, file.content)
            .map_err(|error| format!("Failed to write plugin file: {error}"))?;
    }
    Ok(())
}

/// 编辑器插件数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEditorData {
    pub mode: String,
    pub plugin_id: Option<String>,
    pub is_builtin: bool,
    pub manifest: serde_json::Value,
    pub files: Vec<PluginFile>,
}

/// 加载插件数据用于编辑
#[tauri::command]
pub async fn load_plugin_for_edit(
    app: AppHandle,
    plugin_id: String,
) -> Result<PluginEditorData, String> {
    println!("[PluginEditor] Loading plugin for edit: {}", plugin_id);

    // 获取插件目录路径
    let plugins_dir = plugin_manager::installed_plugin_dir(&app, &plugin_id)?;

    if !plugins_dir.exists() {
        return Err(format!("Plugin not found: {}", plugin_id));
    }

    // 读取 manifest.json
    let manifest_path = plugins_dir.join("manifest.json");
    let manifest_metadata = std::fs::symlink_metadata(&manifest_path)
        .map_err(|e| format!("Failed to inspect manifest: {}", e))?;
    if manifest_metadata.file_type().is_symlink() || !manifest_metadata.is_file() {
        return Err("Plugin manifest must be a regular file".to_string());
    }
    let manifest_content = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest: {}", e))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_content)
        .map_err(|e| format!("Failed to parse manifest: {}", e))?;

    // 读取所有文件
    let mut files = Vec::new();

    // 读取主代码文件
    let code_files = ["index.ts", "index.js", "plugin.ts", "plugin.js"];
    for code_file in code_files {
        let code_path = plugins_dir.join(code_file);
        if code_path.is_file()
            && !std::fs::symlink_metadata(&code_path)
                .is_ok_and(|meta| meta.file_type().is_symlink())
        {
            let content = std::fs::read_to_string(&code_path).unwrap_or_default();
            files.push(PluginFile {
                name: code_file.to_string(),
                content,
            });
            break;
        }
    }

    // 读取样式文件
    let styles_dir = plugins_dir.join("styles");
    if styles_dir.is_dir()
        && !std::fs::symlink_metadata(&styles_dir).is_ok_and(|meta| meta.file_type().is_symlink())
    {
        if let Ok(entries) = std::fs::read_dir(&styles_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.ends_with(".css")
                        && plugin_manager::validate_plugin_file_name(name).is_ok()
                        && entry
                            .file_type()
                            .is_ok_and(|kind| kind.is_file() && !kind.is_symlink())
                    {
                        let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
                        files.push(PluginFile {
                            name: name.to_string(),
                            content,
                        });
                    }
                }
            }
        }
    }

    Ok(PluginEditorData {
        mode: "edit".to_string(),
        plugin_id: Some(plugin_id),
        is_builtin: false,
        manifest,
        files,
    })
}

/// 编辑已安装插件：只能写入应用插件根目录下对应 ID。
#[tauri::command]
pub async fn save_plugin(
    app: AppHandle,
    plugin_id: String,
    manifest: serde_json::Value,
    files: Vec<PluginFile>,
) -> Result<(), String> {
    plugin_manager::validate_plugin_id(&plugin_id)?;
    if manifest.get("id").and_then(serde_json::Value::as_str) != Some(plugin_id.as_str()) {
        return Err("Manifest ID cannot change while editing an installed plugin".to_string());
    }
    let manifest_info: plugin_manager::PluginInfo = serde_json::from_value(manifest.clone())
        .map_err(|error| format!("Invalid plugin manifest: {error}"))?;
    plugin_manager::validate_plugin_manifest(&manifest_info)?;
    let plugin_dir = plugin_manager::installed_plugin_dir(&app, &plugin_id)?;
    if !plugin_dir.exists() {
        return Err("Installed plugin not found".to_string());
    }
    write_plugin_files(&plugin_dir, &manifest, files)
}

/// 导出位置由原生对话框选择，选定后由 Rust 直接写入。
#[tauri::command]
pub async fn export_plugin(
    app: AppHandle,
    default_name: String,
    manifest: serde_json::Value,
    files: Vec<PluginFile>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    plugin_manager::validate_plugin_id(&default_name)?;
    let result = app
        .dialog()
        .file()
        .set_file_name(&format!("{}-plugin", default_name))
        .set_title("导出插件")
        .blocking_save_file();

    let Some(path) = result else { return Ok(None) };
    let directory = path.as_path().ok_or("Selected export path is not local")?;
    write_plugin_files(directory, &manifest, files)?;
    Ok(Some(directory.to_string_lossy().to_string()))
}

/// 从编辑器安装插件（直接保存到应用插件目录）
#[tauri::command]
pub async fn install_plugin_from_editor(
    app: AppHandle,
    manifest: serde_json::Value,
    files: Vec<PluginFile>,
) -> Result<plugin_manager::PluginInfo, String> {
    println!("[PluginEditor] Installing plugin from editor");

    // 获取插件 ID
    let plugin_id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Missing plugin id in manifest")?;

    let mut info: plugin_manager::PluginInfo = serde_json::from_value(manifest.clone())
        .map_err(|error| format!("Invalid plugin manifest: {error}"))?;
    plugin_manager::validate_plugin_manifest(&info)?;
    info.builtin = false;
    info.enabled = true;
    let plugins_dir = plugin_manager::installed_plugin_dir(&app, plugin_id)?;
    write_plugin_files(&plugins_dir, &manifest, files)?;

    // 触发插件更新事件
    let _ = app.emit("plugins-updated", ());
    refresh_app_menu(&app);

    println!(
        "[PluginEditor] Plugin installed: {} v{}",
        info.id, info.version
    );
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temporary_editor_directory(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "wxrd-command-test-{label}-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn web_plugin(domain: serde_json::Value) -> plugin_manager::PluginInfo {
        plugin_manager::PluginInfo {
            id: "host-boundary".to_string(),
            name: "Host Boundary".to_string(),
            version: "1.0.0".to_string(),
            description: None,
            author: None,
            homepage: None,
            icon: None,
            source_type: "web".to_string(),
            site: Some(plugin_manager::PluginSiteConfig {
                domain,
                home_url: "https://example.com".to_string(),
                reader_pattern: "/reader/".to_string(),
            }),
            capabilities: None,
            config_schema: None,
            builtin: false,
            enabled: true,
        }
    }

    #[test]
    fn runtime_plugin_host_matching_respects_dns_label_boundaries() {
        let plugin = web_plugin(json!(["example.com", "*.reader.example.net"]));
        assert!(manifest_matches_host(&plugin, "example.com"));
        assert!(manifest_matches_host(&plugin, "book.example.com"));
        assert!(manifest_matches_host(&plugin, "reader.example.net"));
        assert!(manifest_matches_host(&plugin, "a.reader.example.net"));
        assert!(!manifest_matches_host(&plugin, "evilexample.com"));
        assert!(!manifest_matches_host(&plugin, "example.com.attacker.test"));
        assert!(!manifest_matches_host(
            &plugin,
            "reader.example.net.attacker.test"
        ));
    }

    #[test]
    fn tauri_ipc_dispatches_application_metadata_commands() {
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};

        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![get_app_name, get_app_version])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "settings", Default::default())
            .build()
            .unwrap();

        let invoke = |command: &str| {
            get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
            .unwrap()
            .deserialize::<String>()
            .unwrap()
        };

        assert_eq!(invoke("get_app_name"), "艾特阅读");
        assert_eq!(invoke("get_app_version"), "0.1.0");
    }

    #[test]
    fn runtime_plugin_command_rejects_non_main_and_non_http_windows_before_disk_access() {
        let app = tauri::test::mock_app();
        let settings = tauri::WebviewWindowBuilder::new(&app, "settings", Default::default())
            .build()
            .unwrap();
        let error =
            tauri::async_runtime::block_on(get_runtime_plugin(app.handle().clone(), settings))
                .unwrap_err();
        assert!(error.contains("only available to the main window"));

        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let result =
            tauri::async_runtime::block_on(get_runtime_plugin(app.handle().clone(), main)).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn editor_writer_places_css_in_styles_and_other_files_at_root() {
        let directory = temporary_editor_directory("layout");
        write_plugin_files(
            &directory,
            &json!({ "id": "demo" }),
            vec![
                PluginFile {
                    name: "plugin.js".to_string(),
                    content: "export default class Demo {}".to_string(),
                },
                PluginFile {
                    name: "theme.css".to_string(),
                    content: "body { color: red; }".to_string(),
                },
            ],
        )
        .unwrap();

        assert!(directory.join("manifest.json").is_file());
        assert!(directory.join("plugin.js").is_file());
        assert!(directory.join("styles/theme.css").is_file());
        assert!(!directory.join("theme.css").exists());
        let stored: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(directory.join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(stored["id"], "demo");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn editor_writer_rejects_duplicate_missing_id_and_oversized_input_before_writing() {
        let duplicate = temporary_editor_directory("duplicate");
        let result = write_plugin_files(
            &duplicate,
            &json!({ "id": "demo" }),
            vec![
                PluginFile {
                    name: "plugin.js".to_string(),
                    content: "one".to_string(),
                },
                PluginFile {
                    name: "plugin.js".to_string(),
                    content: "two".to_string(),
                },
            ],
        );
        assert!(result.is_err());
        assert!(!duplicate.exists());

        let missing_id = temporary_editor_directory("missing-id");
        assert!(write_plugin_files(&missing_id, &json!({}), Vec::new()).is_err());

        let oversized = temporary_editor_directory("oversized");
        let content = "x".repeat(4 * 1024 * 1024 + 1);
        assert!(write_plugin_files(
            &oversized,
            &json!({ "id": "demo" }),
            vec![PluginFile {
                name: "plugin.js".to_string(),
                content,
            }],
        )
        .is_err());
        assert!(!oversized.exists());
    }

    #[test]
    fn editor_writer_requires_a_real_directory_root() {
        let path = temporary_editor_directory("root-file");
        std::fs::write(&path, "not a directory").unwrap();
        let result = write_plugin_files(&path, &json!({ "id": "demo" }), Vec::new());
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a directory");
        let _ = std::fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn editor_save_refuses_to_follow_existing_file_symlinks() {
        use std::os::unix::fs::symlink;
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "wxrd-editor-symlink-{}-{unique}",
            std::process::id()
        ));
        let plugin_dir = root.join("plugin");
        let outside = root.join("outside.js");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(&outside, "keep").unwrap();
        symlink(&outside, plugin_dir.join("plugin.js")).unwrap();

        let result = write_plugin_files(
            &plugin_dir,
            &json!({ "id": "demo" }),
            vec![PluginFile {
                name: "plugin.js".to_string(),
                content: "replace".to_string(),
            }],
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
        let _ = std::fs::remove_dir_all(root);
    }
}
