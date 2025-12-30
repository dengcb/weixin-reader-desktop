use tauri::{AppHandle, Manager, Runtime};
use serde_json::Value;
use std::fs;

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
pub fn save_settings<R: Runtime>(app: AppHandle<R>, settings: Value) {
    let data_dir = app.path().app_config_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    if !data_dir.exists() {
        let _ = fs::create_dir_all(&data_dir);
    }
    let settings_path = data_dir.join("settings.json");

    // Read existing to merge
    let mut current = if settings_path.exists() {
        if let Ok(file) = fs::File::open(&settings_path) {
            let reader = std::io::BufReader::new(file);
            serde_json::from_reader(reader).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        }
    } else {
        serde_json::json!({})
    };

    // Merge logic (shallow merge)
    if let Some(obj) = current.as_object_mut() {
        if let Some(new_obj) = settings.as_object() {
            for (k, v) in new_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    
    if let Ok(file) = fs::File::create(settings_path) {
        let _ = serde_json::to_writer(file, &current);
    }
}
