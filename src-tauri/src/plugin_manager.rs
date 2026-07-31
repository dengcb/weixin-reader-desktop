use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};
use zip::ZipArchive;

/// 插件信息（从 manifest.json 读取）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(rename = "sourceType")]
    pub source_type: String,
    #[serde(default)]
    pub site: Option<PluginSiteConfig>,
    #[serde(default)]
    pub capabilities: Option<Value>,
    #[serde(rename = "configSchema", default)]
    pub config_schema: Option<Value>,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub enabled: bool,
}

/// 插件网站配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSiteConfig {
    pub domain: Value, // 可以是 string 或 string[]
    #[serde(rename = "homeUrl")]
    pub home_url: String,
    #[serde(rename = "readerPattern")]
    pub reader_pattern: String,
}

/// 已安装插件信息（存储在 settings.json 中）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledPluginRecord {
    pub id: String,
    pub version: String,
    #[serde(rename = "installedAt")]
    pub installed_at: i64,
    pub enabled: bool,
    #[serde(default)]
    pub builtin: bool,
}

/// 获取插件目录路径
pub fn get_plugins_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get app config dir: {}", e))?;
    Ok(config_dir.join("plugins"))
}

/// 确保插件目录存在
pub fn ensure_plugins_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let plugins_dir = get_plugins_dir(app)?;
    if !plugins_dir.exists() {
        fs::create_dir_all(&plugins_dir)
            .map_err(|e| format!("Failed to create plugins dir: {}", e))?;
    }
    Ok(plugins_dir)
}

/// 从 .atrd 文件安装插件
pub fn install_plugin_from_file<R: Runtime>(app: &AppHandle<R>, file_path: &str) -> Result<PluginInfo, String> {
    let plugins_dir = ensure_plugins_dir(app)?;
    let file = fs::File::open(file_path)
        .map_err(|e| format!("Failed to open plugin file: {}", e))?;
    
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("Failed to read plugin archive: {}", e))?;
    
    // 首先读取 manifest.json 来获取插件 ID
    let manifest = {
        let mut manifest_file = archive.by_name("manifest.json")
            .map_err(|_| "Plugin package missing manifest.json")?;
        let mut content = String::new();
        io::Read::read_to_string(&mut manifest_file, &mut content)
            .map_err(|e| format!("Failed to read manifest.json: {}", e))?;
        serde_json::from_str::<PluginInfo>(&content)
            .map_err(|e| format!("Invalid manifest.json: {}", e))?
    };
    
    // 检查是否已安装
    let plugin_dir = plugins_dir.join(&manifest.id);
    if plugin_dir.exists() {
        // 删除旧版本
        fs::remove_dir_all(&plugin_dir)
            .map_err(|e| format!("Failed to remove existing plugin: {}", e))?;
    }
    
    // 创建插件目录
    fs::create_dir_all(&plugin_dir)
        .map_err(|e| format!("Failed to create plugin dir: {}", e))?;
    
    // 重新打开文件（因为 ZipArchive 消耗了 reader）
    let file = fs::File::open(file_path)
        .map_err(|e| format!("Failed to reopen plugin file: {}", e))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("Failed to read plugin archive: {}", e))?;
    
    // 解压所有文件
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| format!("Failed to read archive entry: {}", e))?;
        
        let outpath = match file.enclosed_name() {
            Some(path) => plugin_dir.join(path),
            None => continue,
        };
        
        if file.is_dir() {
            fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create dir: {}", e))?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    fs::create_dir_all(p)
                        .map_err(|e| format!("Failed to create parent dir: {}", e))?;
                }
            }
            let mut outfile = fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create file: {}", e))?;
            io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Failed to write file: {}", e))?;
        }
    }
    
    let mut result = manifest;
    result.enabled = true;
    Ok(result)
}

/// 卸载插件
pub fn uninstall_plugin<R: Runtime>(app: &AppHandle<R>, plugin_id: &str) -> Result<(), String> {
    let plugins_dir = get_plugins_dir(app)?;
    let plugin_dir = plugins_dir.join(plugin_id);
    
    if plugin_dir.exists() {
        fs::remove_dir_all(&plugin_dir)
            .map_err(|e| format!("Failed to remove plugin: {}", e))?;
    }
    
    Ok(())
}

/// 获取所有已安装的外部插件
pub fn get_installed_plugins<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<PluginInfo>, String> {
    let plugins_dir = get_plugins_dir(app)?;
    let mut plugins = Vec::new();
    
    if !plugins_dir.exists() {
        return Ok(plugins);
    }
    
    let entries = fs::read_dir(&plugins_dir)
        .map_err(|e| format!("Failed to read plugins dir: {}", e))?;
    
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let path = entry.path();
        
        if path.is_dir() {
            let manifest_path = path.join("manifest.json");
            if manifest_path.exists() {
                let content = fs::read_to_string(&manifest_path)
                    .map_err(|e| format!("Failed to read manifest: {}", e))?;
                if let Ok(mut info) = serde_json::from_str::<PluginInfo>(&content) {
                    info.enabled = true; // 外部插件默认启用
                    plugins.push(info);
                }
            }
        }
    }
    
    Ok(plugins)
}

/// 读取插件的 manifest.json
pub fn get_plugin_manifest<R: Runtime>(app: &AppHandle<R>, plugin_id: &str) -> Result<PluginInfo, String> {
    let plugins_dir = get_plugins_dir(app)?;
    let manifest_path = plugins_dir.join(plugin_id).join("manifest.json");
    
    if !manifest_path.exists() {
        return Err(format!("Plugin '{}' not found", plugin_id));
    }
    
    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Invalid manifest: {}", e))
}

/// 读取插件代码
pub fn get_plugin_code<R: Runtime>(app: &AppHandle<R>, plugin_id: &str) -> Result<String, String> {
    let plugins_dir = get_plugins_dir(app)?;
    let code_path = plugins_dir.join(plugin_id).join("plugin.js");
    
    if !code_path.exists() {
        return Err(format!("Plugin code not found for '{}'", plugin_id));
    }
    
    fs::read_to_string(&code_path)
        .map_err(|e| format!("Failed to read plugin code: {}", e))
}

/// 获取插件配置
pub fn get_plugin_config<R: Runtime>(app: &AppHandle<R>, plugin_id: &str) -> Result<Value, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    let settings_path = config_dir.join("settings.json");
    
    if !settings_path.exists() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    
    let content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings: {}", e))?;
    let settings: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid settings: {}", e))?;
    
    Ok(settings
        .get("pluginConfigs")
        .and_then(|c| c.get(plugin_id))
        .cloned()
        .unwrap_or(Value::Object(serde_json::Map::new())))
}

/// 保存插件配置
pub fn save_plugin_config<R: Runtime>(app: &AppHandle<R>, plugin_id: &str, config: Value) -> Result<(), String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    let settings_path = config_dir.join("settings.json");
    
    let mut settings: Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Invalid settings: {}", e))?
    } else {
        Value::Object(serde_json::Map::new())
    };
    
    // 确保 pluginConfigs 对象存在
    if !settings.get("pluginConfigs").is_some() {
        settings["pluginConfigs"] = Value::Object(serde_json::Map::new());
    }
    
    // 更新插件配置
    settings["pluginConfigs"][plugin_id] = config;
    
    // 保存
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&settings_path, content)
        .map_err(|e| format!("Failed to write settings: {}", e))?;
    
    Ok(())
}
