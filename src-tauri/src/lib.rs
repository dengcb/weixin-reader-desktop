use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

mod menu;

#[tauri::command]
fn update_menu_state(app: tauri::AppHandle, id: String, state: bool) {
    if let Some(menu) = app.menu() {
        if let Some(item) = menu.get(&id) {
            if let Some(check_item) = item.as_check_menuitem() {
                let _ = check_item.set_checked(state);
            }
        }
    }
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> serde_json::Value {
    let data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let settings_path = data_dir.join("settings.json");
    if settings_path.exists() {
        if let Ok(file) = std::fs::File::open(settings_path) {
            let reader = std::io::BufReader::new(file);
            if let Ok(v) = serde_json::from_reader(reader) {
                return v;
            }
        }
    }
    serde_json::json!({})
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: serde_json::Value) {
     let data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
     if !data_dir.exists() {
         let _ = std::fs::create_dir_all(&data_dir);
     }
     let settings_path = data_dir.join("settings.json");
     
     // Read existing to merge
     let mut current = if settings_path.exists() {
        if let Ok(file) = std::fs::File::open(&settings_path) {
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
     
     if let Ok(file) = std::fs::File::create(settings_path) {
         let _ = serde_json::to_writer(file, &current);
     }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let inject_script = include_str!("../../src/scripts/inject.js");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            // Menu Init
            menu::init(app)?;

            // Create Main Window
            let url = WebviewUrl::External("https://weread.qq.com/".parse().unwrap());
            let _win = WebviewWindowBuilder::new(app, "main", url)
                .title("微信阅读")
                .inner_size(1280.0, 800.0)
                .center()
                .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                .initialization_script(inject_script)
                .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![update_menu_state, get_settings, save_settings])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
