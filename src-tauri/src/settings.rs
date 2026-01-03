use tauri::{AppHandle, Manager, Runtime};
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

            // Merge logic (shallow merge)
    // IMPORTANT: Only allow specific top-level keys to prevent data pollution
    // Valid keys: _version, global, sites
    // Old flat keys (readerWide, hideToolbar, etc.) will be removed
    if let Some(obj) = current.as_object_mut() {
        if let Some(new_obj) = settings.as_object() {
            // Define allowed top-level keys
            let allowed_keys = vec!["_version", "global", "sites"];

            // First, remove all keys that are not in the allowed list
            let keys_to_remove: Vec<String> = obj.keys()
                .filter(|k| !allowed_keys.contains(&k.as_str()))
                .cloned()
                .collect();

            for key in keys_to_remove {
                obj.remove(&key);
                println!("[Settings] Removed legacy key: {}", key);
            }

            // Then, merge new settings (only allowed keys)
            for (k, v) in new_obj {
                if allowed_keys.contains(&k.as_str()) {
                    obj.insert(k.clone(), v.clone());
                }
            }

            // FORCE override _version with the version argument if provided
            // This prevents the frontend from accidentally overwriting the version with an old value
            if let Some(ver) = version {
                obj.insert("_version".to_string(), serde_json::json!(ver));
            } else if let Some(ver_val) = new_obj.get("_version") {
                // Only if version arg is missing, fallback to the payload version
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
