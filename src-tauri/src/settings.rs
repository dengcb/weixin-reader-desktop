use tauri::{AppHandle, Emitter, Manager, Runtime};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::sync::Mutex;

// Global mutex for settings file access
// Ensures atomic read-modify-write operations across all windows
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

pub fn get_settings_path<R: Runtime>(app: &AppHandle<R>) -> std::path::PathBuf {
    let data_dir = app.path().app_config_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    data_dir.join("settings.json")
}

#[tauri::command]
pub fn get_settings<R: Runtime>(app: AppHandle<R>) -> Value {
    let settings_path = get_settings_path(&app);
    
    if settings_path.exists() {
        if let Ok(file) = fs::File::open(settings_path) {
            let reader = std::io::BufReader::new(file);
            if let Ok(v) = serde_json::from_reader(reader) {
                return v;
            }
        }
    }
    serde_json::json!({})
}

#[tauri::command]
pub fn save_settings<R: Runtime>(app: AppHandle<R>, settings: Value, version: Option<u64>) {
    // Acquire global lock to ensure atomic read-modify-write
    // This prevents concurrent modifications from different windows
    let _lock = SETTINGS_LOCK.lock().unwrap();

    let data_dir = app.path().app_config_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    if !data_dir.exists() {
        let _ = fs::create_dir_all(&data_dir);
    }
    let settings_path = data_dir.join("settings.json");

    // Read existing settings to get current version
    let mut current = if settings_path.exists() {
        if let Ok(file) = File::open(&settings_path) {
            let reader = std::io::BufReader::new(file);
            serde_json::from_reader(reader).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        }
    } else {
        serde_json::json!({})
    };

    // Optimistic lock: Check version AFTER acquiring mutex
    let current_version = current.get("_version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    if let Some(new_version) = version {
        if new_version <= current_version {
            eprintln!("[Settings] CONFLICT: Rejecting stale update version {} <= current version {}", new_version, current_version);
            return; // Reject old version
        }
        println!("[Settings] Accepting update: version {} > current version {}", new_version, current_version);
    }

            // Merge new settings (deep merge for global and sites)
    // Only allow specific top-level keys to prevent data pollution
    // Valid keys: _version, global, sites
    if let Some(obj) = current.as_object_mut() {
        if let Some(new_obj) = settings.as_object() {
            let allowed_keys = vec!["_version", "global", "sites"];

            // Remove all keys that are not in the allowed list
            let keys_to_remove: Vec<String> = obj.keys()
                .filter(|k| !allowed_keys.contains(&k.as_str()))
                .cloned()
                .collect();

            for key in keys_to_remove {
                obj.remove(&key);
            }

            // Deep merge global and sites (recursive)
            for (k, v) in new_obj {
                if allowed_keys.contains(&k.as_str()) {
                    match k.as_str() {
                        "global" | "sites" => {
                            // Deep merge nested objects
                            if !obj.contains_key(k.as_str()) {
                                obj.insert(k.clone(), serde_json::json!({}));
                            }
                            if let Some(target) = obj.get_mut(k.as_str()).and_then(|v| v.as_object_mut()) {
                                deep_merge(target, v);
                            }
                        }
                        _ => {
                            // _version and any other scalar: direct insert
                            obj.insert(k.clone(), v.clone());
                        }
                    }
                }
            }

            // FORCE override _version
            if let Some(ver) = version {
                obj.insert("_version".to_string(), serde_json::json!(ver));
            } else if let Some(ver_val) = new_obj.get("_version") {
                obj.insert("_version".to_string(), ver_val.clone());
            }
        }
    }

    // Write with proper error handling and flush
    match fs::File::create(&settings_path) {
        Ok(file) => {
            let mut writer = BufWriter::new(file);
            match serde_json::to_writer_pretty(&mut writer, &current) {
                Ok(_) => {
                    if let Err(e) = writer.flush() {
                        eprintln!("[Settings] Failed to flush settings: {}", e);
                    } else {
                        let saved_version = current.get("_version")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        println!("[Settings] Settings saved successfully: {} (version: {})", settings_path.display(), saved_version);
                    }
                }
                Err(e) => {
                    eprintln!("[Settings] Failed to write settings: {}", e);
                }
            }
        }
        Err(e) => {
            eprintln!("[Settings] Failed to create settings file: {}", e);
        }
    }
}

/// Recursively merge source into target (deep merge).
/// For nested objects, merge key by key; for scalars, overwrite.
fn deep_merge(target: &mut serde_json::Map<String, Value>, source: &Value) {
    if let Some(source_obj) = source.as_object() {
        for (key, val) in source_obj {
            if val.is_object() && target.get(key).map_or(false, |v| v.is_object()) {
                // Both are objects: recurse
                if let Some(inner_target) = target.get_mut(key).and_then(|v| v.as_object_mut()) {
                    deep_merge(inner_target, val);
                }
            } else {
                // Scalar or new key: direct insert
                target.insert(key.clone(), val.clone());
            }
        }
    }
}

/// Path-style update: reads current settings, applies deep merge at the given path,
/// auto-increments version, writes, and emits `settings-updated` to notify frontend.
///
/// # Example
/// ```ignore
/// update_setting(&app, "global.lastSiteId", serde_json::json!("fanqie"));
/// update_setting(&app, "sites.weread.zoom", serde_json::json!(0.75));
/// ```
pub fn update_setting<R: Runtime>(app: &AppHandle<R>, path: &str, value: Value) {
    let _lock = SETTINGS_LOCK.lock().unwrap();

    let settings_path = get_settings_path(app);
    if let Some(parent) = settings_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // Read current settings
    let mut current: Value = if settings_path.exists() {
        if let Ok(file) = File::open(&settings_path) {
            let reader = std::io::BufReader::new(file);
            serde_json::from_reader(reader).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        }
    } else {
        serde_json::json!({})
    };

    // Navigate to the path and set the value
    let keys: Vec<&str> = path.split('.').collect();
    set_nested_value(&mut current, &keys, value);

    // Auto-increment version
    let current_version = current.get("_version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if let Some(obj) = current.as_object_mut() {
        obj.insert("_version".to_string(), serde_json::json!(current_version + 1));
    }

    // Write
    if let Ok(file) = fs::File::create(&settings_path) {
        let mut writer = BufWriter::new(file);
        if serde_json::to_writer_pretty(&mut writer, &current).is_ok() {
            let _ = writer.flush();
            let new_version = current.get("_version").and_then(|v| v.as_u64()).unwrap_or(0);
            println!("[Settings] update_setting: {} -> {} (version: {})", path, settings_path.display(), new_version);
        }
    }

    // Notify frontend to reload
    let _ = app.emit("settings-updated", ());
}

/// Set a value at a dotted path inside a JSON object, creating intermediate objects as needed.
fn set_nested_value(root: &mut Value, keys: &[&str], value: Value) {
    if keys.is_empty() {
        return;
    }

    if !root.is_object() {
        *root = serde_json::json!({});
    }

    let obj = root.as_object_mut().unwrap();

    if keys.len() == 1 {
        obj.insert(keys[0].to_string(), value);
    } else {
        if !obj.contains_key(keys[0]) || !obj[keys[0]].is_object() {
            obj.insert(keys[0].to_string(), serde_json::json!({}));
        }
        if let Some(child) = obj.get_mut(keys[0]) {
            set_nested_value(child, &keys[1..], value);
        }
    }
}
