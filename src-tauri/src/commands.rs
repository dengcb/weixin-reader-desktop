use tauri::{AppHandle, Manager, WebviewWindow, Emitter};
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};

// Lazy static to store the current log file paths
// Using Mutex to safely access from multiple threads
static CURRENT_FRONTEND_LOG: Mutex<Option<String>> = Mutex::new(None);

/// Monitor information for multi-monitor support
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

#[tauri::command]
pub fn log_frontend(message: String) {
    println!("[Frontend] {}", message);
}

#[tauri::command]
pub fn log_to_file(_app: AppHandle, message: String) {
    // In dev mode, current_dir() is src-tauri, so go to parent for project root
    let project_root = std::env::current_dir()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from(".."));

    let log_dir = project_root.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);

    // Get or create log file for this session
    let log_file = {
        let mut log_guard = CURRENT_FRONTEND_LOG.lock().unwrap();
        if log_guard.is_none() {
            let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let filename = format!("frontend-{}.log", timestamp);
            let path = log_dir.join(&filename).to_string_lossy().to_string();
            *log_guard = Some(path.clone());
            path
        } else {
            log_guard.as_ref().unwrap().clone()
        }
    };

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_file) {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(file, "[{}] {}", timestamp, message);
    }
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
                    if found { break; }
                }
            }
        }
    }

    if !found {
        eprintln!("[Menu] set_menu_item_enabled: NOT FOUND - id={}, enabled={}", id, enabled);
    }
}

/// 设置当前活跃书店（书店菜单单选对勾）
/// 找到「书店」子菜单，将 site_id 对应项勾上、其余取消
#[tauri::command]
pub fn set_active_bookstore(app: AppHandle, site_id: String) {
    println!("[Bookstore] set_active_bookstore called: site_id={}", site_id);
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
                                    println!("[Bookstore]   item={} -> checked={}", it.id().0, want);
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
pub fn set_zoom(app: AppHandle, value: f64) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_zoom(value);
    }
}

#[tauri::command]
pub fn close_window(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
pub fn set_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

#[tauri::command]
pub fn get_app_name(app: AppHandle) -> String {
    app.config().product_name.clone().unwrap_or("艾特阅读".to_string())
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.config().version.clone().unwrap_or("0.1.0".to_string())
}

/// Get list of available monitors
#[tauri::command]
pub fn get_available_monitors(window: WebviewWindow) -> Result<Vec<MonitorInfo>, String> {
    let monitors = window.available_monitors()
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for monitor in monitors {
        let pos = monitor.position();
        let size = monitor.size();
        let name = monitor.name();
        let display_name = format!("Display {}", pos.x);
        let name_str = name.as_deref().unwrap_or(&display_name);
        result.push(MonitorInfo {
            name: name_str.to_string(),
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            scale_factor: monitor.scale_factor(),
        });
    }

    Ok(result)
}

/// Move window to the specified monitor
#[tauri::command]
pub fn move_window_to_monitor(window: WebviewWindow, monitor_name: String) -> Result<(), String> {
    let monitors = window.available_monitors()
        .map_err(|e| e.to_string())?;

    // Find the target monitor by name
    let target_monitor = monitors
        .iter()
        .find(|m| {
            let name = m.name();
            let pos = m.position();
            let display_name = format!("Display {}", pos.x);
            let name_str = name.as_deref().unwrap_or(&display_name);
            name_str == monitor_name.as_str()
        })
        .ok_or_else(|| format!("Monitor '{}' not found", monitor_name))?;

    // Get current window size
    let current_size = window.outer_size()
        .map_err(|e| e.to_string())?;

    // Calculate centered position on target monitor
    let pos = target_monitor.position();
    let size = target_monitor.size();
    let x = pos.x + (size.width as i32 - current_size.width as i32) / 2;
    let y = pos.y + (size.height as i32 - current_size.height as i32) / 2;

    window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x as f64, y as f64)))
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Get current monitor info
#[tauri::command]
pub fn get_current_monitor(window: WebviewWindow) -> Result<MonitorInfo, String> {
    let monitor = window.current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No current monitor found".to_string())?;

    let pos = monitor.position();
    let size = monitor.size();
    let name = monitor.name();
    let display_name = format!("Display {}", pos.x);
    let name_str = name.as_deref().unwrap_or(&display_name);
    Ok(MonitorInfo {
        name: name_str.to_string(),
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        scale_factor: monitor.scale_factor(),
    })
}

/// Navigate to URL (for restoring last page)
#[tauri::command]
pub fn navigate_to_url(window: WebviewWindow, url: String) {
    println!("[Navigate] Navigating to: {}", url);
    let _ = window.eval(&format!("window.location.href = {}", serde_json::to_string(&url).unwrap()));
}

/// Set cursor visibility
#[tauri::command]
pub fn set_cursor_visible(window: WebviewWindow, visible: bool) {
    let _ = window.set_cursor_visible(visible);
}

/// 微信读书阅读进度响应数据
#[derive(Debug, Serialize, Deserialize)]
pub struct WeReadBookProgress {
    pub progress: Option<i32>,
    pub reading_time: Option<i64>,
    pub last_read_date: Option<String>,
    pub chapter_uid: Option<i64>,
    pub chapter_idx: Option<i32>,
    pub summary: Option<String>,
}

/// 微信读书 API 响应
#[derive(Debug, Serialize, Deserialize)]
struct WeReadApiResponse {
    #[serde(rename = "errCode")]
    err_code: Option<i32>,
    #[serde(rename = "errMsg")]
    err_msg: Option<String>,
    book: Option<WeReadBookData>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WeReadBookData {
    progress: Option<i32>,
    #[serde(rename = "readingTime")]
    reading_time: Option<i64>,
    #[serde(rename = "updateTime")]
    update_time: Option<i64>,
    #[serde(rename = "chapterUid")]
    chapter_uid: Option<i64>,
    #[serde(rename = "chapterIdx")]
    chapter_idx: Option<i32>,
    summary: Option<String>,
}

/// 获取微信读书阅读进度
/// 使用浏览器 Cookie 进行认证
/// 注意：由于 HttpOnly Cookie 无法通过 JavaScript 读取，我们需要让前端直接调用 API
#[tauri::command]
pub async fn get_weread_book_progress(
    _window: WebviewWindow,
    book_id: String,
    cookies: String,
) -> Result<Option<WeReadBookProgress>, String> {
    println!("[WeReadAPI] Fetching progress for bookId: {}", book_id);
    println!("[WeReadAPI] Cookie length: {} chars", cookies.len());
    println!("[WeReadAPI] Cookie preview: {}", &cookies[..std::cmp::min(150, cookies.len())]);

    // 构建请求 URL
    let url = format!(
        "https://weread.qq.com/web/book/getProgress?bookId={}&_={}",
        book_id,
        chrono::Utc::now().timestamp_millis()
    );

    // 创建 HTTP 客户端（禁用代理，直接连接）
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .no_proxy()  // 禁用系统代理
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // 发送请求，携带 Cookie（但可能不完整，缺少 HttpOnly Cookie）
    let response = client
        .get(&url)
        .header("Cookie", cookies)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15")
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .header("Referer", "https://weread.qq.com/")
        .header("Origin", "https://weread.qq.com")
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    println!("[WeReadAPI] Response status: {}", response.status());

    // 解析响应
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    println!("[WeReadAPI] Response body: {}", response_text);

    let api_response: WeReadApiResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse JSON: {} | Response: {}", e, response_text))?;

    // 检查错误码
    if let Some(err_code) = api_response.err_code {
        if err_code != 0 {
            let err_msg = api_response.err_msg.unwrap_or_else(|| "Unknown error".to_string());
            println!("[WeReadAPI] API error: {} - {}", err_code, err_msg);

            // Cookie 过期错误，静默返回 None
            if err_code == -2010 || err_code == -2012 {
                println!("[WeReadAPI] Cookie expired or invalid");
                return Ok(None);
            }

            return Err(format!("API error {}: {}", err_code, err_msg));
        }
    }

    // 提取数据
    println!("[WeReadAPI] Parsed API response, book field exists: {}", api_response.book.is_some());
    if let Some(book) = api_response.book {
        println!("[WeReadAPI] Success! Progress: {}%", book.progress.unwrap_or(0));
        Ok(Some(WeReadBookProgress {
            progress: book.progress,
            reading_time: book.reading_time,
            last_read_date: book.update_time.map(|ts| {
                chrono::DateTime::from_timestamp(ts, 0)
                    .unwrap()
                    .to_rfc3339()
            }),
            chapter_uid: book.chapter_uid,
            chapter_idx: book.chapter_idx,
            summary: book.summary,
        }))
    } else {
        println!("[WeReadAPI] No book data in response");
        Ok(None)
    }
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
pub async fn install_plugin(app: AppHandle, path: String) -> Result<plugin_manager::PluginInfo, String> {
    println!("[Plugin] Installing plugin from: {}", path);
    let result = plugin_manager::install_plugin_from_file(&app, &path)?;
    println!("[Plugin] Plugin installed: {} v{}", result.id, result.version);
    
    // 触发设置更新事件，通知前端
    let _ = app.emit("plugins-updated", ());
    refresh_app_menu(&app);
    
    Ok(result)
}

/// 若主窗口当前停留在指定插件的站点上，先导航回微信读书（优先续读上次阅读页，无则首页）
/// 用于卸载前脱离该站点，避免卸载后滞留在无插件支撑、且无书店菜单可切换的页面上
fn navigate_home_if_on_plugin_site(app: &AppHandle, plugin_id: &str) {
    let Some(win) = app.get_webview_window("main") else { return };
    let Ok(url) = win.url() else { return };
    let Some(host) = url.host_str().map(|h| h.to_string()) else { return };

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
    let settings = crate::settings::get_settings(app.clone());
    let target = settings
        .get("sites")
        .and_then(|s| s.get("weread"))
        .and_then(|s| s.get("lastReaderUrl"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .or_else(|| crate::sites::resolve_home_url(app, "weread"));
    if let Some(t) = target {
        if let Ok(u) = t.parse::<tauri::Url>() {
            println!("[Plugin] Main window is on '{}' site, navigating back to weread before uninstall", plugin_id);
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
pub async fn get_installed_plugins(app: AppHandle) -> Result<Vec<plugin_manager::PluginInfo>, String> {
    plugin_manager::get_installed_plugins(&app)
}

/// 获取插件配置
#[tauri::command]
pub async fn get_plugin_config(app: AppHandle, plugin_id: String) -> Result<serde_json::Value, String> {
    plugin_manager::get_plugin_config(&app, &plugin_id)
}

/// 保存插件配置
#[tauri::command]
pub async fn save_plugin_config(app: AppHandle, plugin_id: String, config: serde_json::Value) -> Result<(), String> {
    plugin_manager::save_plugin_config(&app, &plugin_id, config)?;
    
    // 触发设置更新事件
    let _ = app.emit("settings-updated", ());
    
    Ok(())
}

/// 获取插件代码
#[tauri::command]
pub async fn get_plugin_code(app: AppHandle, plugin_id: String) -> Result<String, String> {
    plugin_manager::get_plugin_code(&app, &plugin_id)
}

// ==================== 插件编辑器命令 ====================

/// 插件文件数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginFile {
    pub name: String,
    pub content: String,
}

/// 编辑器插件数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEditorData {
    pub mode: String,
    pub plugin_id: Option<String>,
    pub plugin_path: Option<String>,
    pub is_builtin: bool,
    pub manifest: serde_json::Value,
    pub files: Vec<PluginFile>,
}

/// 加载插件数据用于编辑
#[tauri::command]
pub async fn load_plugin_for_edit(app: AppHandle, plugin_id: String) -> Result<PluginEditorData, String> {
    println!("[PluginEditor] Loading plugin for edit: {}", plugin_id);
    
    // 获取插件目录路径
    let plugins_dir = app.path().app_config_dir()
        .map_err(|e| e.to_string())?
        .join("plugins")
        .join(&plugin_id);
    
    if !plugins_dir.exists() {
        return Err(format!("Plugin not found: {}", plugin_id));
    }
    
    // 读取 manifest.json
    let manifest_path = plugins_dir.join("manifest.json");
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
        if code_path.exists() {
            let content = std::fs::read_to_string(&code_path)
                .unwrap_or_default();
            files.push(PluginFile {
                name: code_file.to_string(),
                content,
            });
            break;
        }
    }
    
    // 读取样式文件
    let styles_dir = plugins_dir.join("styles");
    if styles_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&styles_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.ends_with(".css") {
                        let content = std::fs::read_to_string(entry.path())
                            .unwrap_or_default();
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
        plugin_path: Some(plugins_dir.to_string_lossy().to_string()),
        is_builtin: false,
        manifest,
        files,
    })
}

/// 保存插件到指定路径
#[tauri::command]
pub async fn save_plugin(
    path: String,
    manifest: serde_json::Value,
    files: Vec<PluginFile>,
) -> Result<(), String> {
    println!("[PluginEditor] Saving plugin to: {}", path);
    
    let plugin_dir = std::path::Path::new(&path);
    
    // 创建插件目录
    std::fs::create_dir_all(plugin_dir)
        .map_err(|e| format!("Failed to create plugin directory: {}", e))?;
    
    // 保存 manifest.json
    let manifest_path = plugin_dir.join("manifest.json");
    let manifest_str = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    std::fs::write(&manifest_path, manifest_str)
        .map_err(|e| format!("Failed to write manifest: {}", e))?;
    
    // 保存其他文件
    for file in files {
        let file_path = if file.name.ends_with(".css") {
            // CSS 文件放在 styles 目录
            let styles_dir = plugin_dir.join("styles");
            std::fs::create_dir_all(&styles_dir)
                .map_err(|e| format!("Failed to create styles directory: {}", e))?;
            styles_dir.join(&file.name)
        } else {
            plugin_dir.join(&file.name)
        };
        
        std::fs::write(&file_path, &file.content)
            .map_err(|e| format!("Failed to write file {}: {}", file.name, e))?;
    }
    
    println!("[PluginEditor] Plugin saved successfully");
    Ok(())
}

/// 打开保存对话框
#[tauri::command]
pub async fn save_plugin_dialog(app: AppHandle, default_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    
    let result = app.dialog()
        .file()
        .set_file_name(&format!("{}-plugin", default_name))
        .set_title("保存插件")
        .blocking_save_file();
    
    match result {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
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
    let plugin_id = manifest.get("id")
        .and_then(|v| v.as_str())
        .ok_or("Missing plugin id in manifest")?;
    
    // 获取应用插件目录
    let plugins_dir = app.path().app_config_dir()
        .map_err(|e| e.to_string())?
        .join("plugins")
        .join(plugin_id);
    
    // 保存到插件目录
    save_plugin(plugins_dir.to_string_lossy().to_string(), manifest.clone(), files).await?;
    
    // 返回插件信息
    let info = plugin_manager::PluginInfo {
        id: plugin_id.to_string(),
        name: manifest.get("name").and_then(|v| v.as_str()).unwrap_or(plugin_id).to_string(),
        version: manifest.get("version").and_then(|v| v.as_str()).unwrap_or("1.0.0").to_string(),
        description: manifest.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
        author: manifest.get("author").and_then(|v| v.as_str()).map(|s| s.to_string()),
        homepage: manifest.get("homepage").and_then(|v| v.as_str()).map(|s| s.to_string()),
        icon: manifest.get("icon").and_then(|v| v.as_str()).map(|s| s.to_string()),
        source_type: manifest.get("sourceType").and_then(|v| v.as_str()).unwrap_or("web").to_string(),
        site: manifest.get("site").map(|v| {
            serde_json::from_value(v.clone()).ok()
        }).flatten(),
        builtin: false,
        enabled: true,
        capabilities: manifest.get("capabilities").cloned(),
        config_schema: manifest.get("configSchema").cloned(),
    };
    
    // 触发插件更新事件
    let _ = app.emit("plugins-updated", ());
    refresh_app_menu(&app);
    
    println!("[PluginEditor] Plugin installed: {} v{}", info.id, info.version);
    Ok(info)
}
