use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;
use std::time::Duration;
use crate::settings;
use serde::Serialize;
use std::sync::Mutex;
use tauri::menu::MenuItem;

// State to hold the menu item for updating text
pub struct MenuState<R: Runtime> {
    pub check_update_item: Mutex<Option<MenuItem<R>>>,
}

// State to track if update is downloaded
pub struct UpdateState {
    pub downloaded: Mutex<bool>,
}

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub has_update: bool,
    pub version: String,
    pub body: String,
}

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    app.manage(UpdateState {
        downloaded: Mutex::new(false),
    });

    let app_handle = app.clone();

    // Spawn background task
    tauri::async_runtime::spawn(async move {
        // Wait longer for menu to be fully initialized
        // MenuManager needs ~3 seconds, so we wait 10 seconds to be safe
        tokio::time::sleep(Duration::from_secs(10)).await;

        loop {
            check_silent(&app_handle).await;
            // Check every 24 hours
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });
}

// Silent check (Background)
async fn check_silent<R: Runtime>(app: &AppHandle<R>) {
    // 1. Check settings
    let settings = settings::get_settings(app.clone());
    let auto_update = settings.get("autoUpdate").and_then(|v| v.as_bool()).unwrap_or(true);

    if !auto_update {
        return;
    }

    // 2. Check update with timeout protection
    if let Ok(updater) = app.updater_builder().build() {
        // Add 10 second timeout to prevent hanging on network issues
        let check_result = tokio::time::timeout(
            Duration::from_secs(10),
            updater.check()
        ).await;

        match check_result {
            Ok(Ok(Some(update))) => {
                println!("Found silent update: v{}", update.version);
                // Disable menu item during download
                if let Some(menu_state) = app.try_state::<MenuState<R>>() {
                    if let Ok(guard) = menu_state.check_update_item.lock() {
                        if let Some(item) = guard.as_ref() {
                            let _ = item.set_enabled(false);
                            let _ = item.set_text("正在下载更新...");
                        }
                    }
                }
                // Found update, download it with timeout
                let download_result = tokio::time::timeout(
                    Duration::from_secs(30), // 30 seconds for 3MB file
                    update.download_and_install(|_, _| {}, || {})
                ).await;

                match download_result {
                    Ok(Ok(())) => {
                        println!("Auto-update downloaded and installed (pending restart)");
                        // Mark as downloaded
                        if let Some(state) = app.try_state::<UpdateState>() {
                            *state.downloaded.lock().unwrap() = true;
                        }
                        // Update Menu Text and re-enable
                        if let Some(menu_state) = app.try_state::<MenuState<R>>() {
                            if let Ok(guard) = menu_state.check_update_item.lock() {
                                if let Some(item) = guard.as_ref() {
                                    let _ = item.set_text("重启并安装");
                                    let _ = item.set_enabled(true);
                                    println!("Menu updated to '重启并安装' and enabled");
                                }
                            }
                        }
                    }
                    Ok(Err(e)) => {
                        println!("Auto-update failed: {}", e);
                        // Re-enable menu on error
                        if let Some(menu_state) = app.try_state::<MenuState<R>>() {
                            if let Ok(guard) = menu_state.check_update_item.lock() {
                                if let Some(item) = guard.as_ref() {
                                    let _ = item.set_text("检查更新...");
                                    let _ = item.set_enabled(true);
                                }
                            }
                        }
                    }
                    Err(_) => {
                        println!("Auto-update download timed out after 30 seconds");
                        // Re-enable menu on timeout
                        if let Some(menu_state) = app.try_state::<MenuState<R>>() {
                            if let Ok(guard) = menu_state.check_update_item.lock() {
                                if let Some(item) = guard.as_ref() {
                                    let _ = item.set_text("检查更新...");
                                    let _ = item.set_enabled(true);
                                }
                            }
                        }
                    }
                }
            }
            Ok(Ok(None)) => {}
            Ok(Err(e)) => println!("Failed to check update: {}", e),
            Err(_) => println!("Update check timed out after 10 seconds (network issue)"),
        }
    }
}

// Manual Check (Command)
#[tauri::command]
pub async fn check_update_manual<R: Runtime>(app: AppHandle<R>) -> Result<UpdateInfo, String> {
    // Disable menu during check
    if let Some(menu_state) = app.try_state::<MenuState<R>>() {
        if let Ok(guard) = menu_state.check_update_item.lock() {
            if let Some(item) = guard.as_ref() {
                let _ = item.set_enabled(false);
                let _ = item.set_text("正在检测更新...");
            }
        }
    }

    let updater = app.updater_builder().build().map_err(|e| e.to_string())?;

    // Add 15 second timeout for manual check
    let check_result = tokio::time::timeout(
        Duration::from_secs(15),
        updater.check()
    ).await;

    match check_result {
        Ok(Ok(Some(update))) => {
            // Update Menu Text to indicate update is available
            if let Some(menu_state) = app.try_state::<MenuState<R>>() {
                if let Ok(guard) = menu_state.check_update_item.lock() {
                    if let Some(item) = guard.as_ref() {
                        let _ = item.set_text("发现新版本");
                        let _ = item.set_enabled(true);
                    }
                }
            }

            Ok(UpdateInfo {
                has_update: true,
                version: update.version,
                body: update.body.unwrap_or_default(),
            })
        }
        Ok(Ok(None)) => {
            // Re-enable menu when no update
            if let Some(menu_state) = app.try_state::<MenuState<R>>() {
                if let Ok(guard) = menu_state.check_update_item.lock() {
                    if let Some(item) = guard.as_ref() {
                        let _ = item.set_text("检查更新...");
                        let _ = item.set_enabled(true);
                    }
                }
            }
            // Get current version
            let version = app.package_info().version.to_string();
            Ok(UpdateInfo {
                has_update: false,
                version,
                body: String::new(),
            })
        }
        Ok(Err(e)) => {
            // Re-enable menu on error
            if let Some(menu_state) = app.try_state::<MenuState<R>>() {
                if let Ok(guard) = menu_state.check_update_item.lock() {
                    if let Some(item) = guard.as_ref() {
                        let _ = item.set_text("检查更新...");
                        let _ = item.set_enabled(true);
                    }
                }
            }
            Err(e.to_string())
        }
        Err(_) => {
            // Re-enable menu on timeout
            if let Some(menu_state) = app.try_state::<MenuState<R>>() {
                if let Ok(guard) = menu_state.check_update_item.lock() {
                    if let Some(item) = guard.as_ref() {
                        let _ = item.set_text("检查更新...");
                        let _ = item.set_enabled(true);
                    }
                }
            }
            Err("连接超时，请检查网络连接".to_string())
        }
    }
}

// Install Now (Command)
#[tauri::command]
pub async fn install_update_now<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    // Check if update is already downloaded
    if let Some(state) = app.try_state::<UpdateState>() {
        if *state.downloaded.lock().unwrap() {
            // Already downloaded, just restart
            app.restart();
        } else {
            // Not downloaded yet, download and install
            let updater = app.updater_builder().build().map_err(|e| e.to_string())?;

            if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
                update
                    .download_and_install(
                        |_, _| {},
                        || {},
                    )
                    .await
                    .map_err(|e| e.to_string())?;

                // Restart app
                app.restart();
            }
        }
    } else {
        // No state found, proceed with download
        let updater = app.updater_builder().build().map_err(|e| e.to_string())?;

        if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
            update
                .download_and_install(
                    |_, _| {},
                    || {},
                )
                .await
                .map_err(|e| e.to_string())?;

            // Restart app
            app.restart();
        }
    }

    Ok(())
}

// Check if update is already downloaded
#[tauri::command]
pub fn is_update_downloaded<R: Runtime>(app: AppHandle<R>) -> bool {
    if let Some(state) = app.try_state::<UpdateState>() {
        *state.downloaded.lock().unwrap()
    } else {
        false
    }
}
