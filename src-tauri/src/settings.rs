use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const SETTINGS_SCHEMA_VERSION: u64 = 2;
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 设置文档的唯一持久化边界。
///
/// 前端只提交 patch；读取、版本比较、锁和原子替换都在此完成。
pub struct SettingsRepository;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default)]
    pub global: Option<Value>,
    #[serde(default)]
    pub sites: Option<Value>,
    #[serde(default)]
    pub plugin_configs: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PatchOutcome {
    Applied { settings: Value },
    Conflict { latest: Value },
}

pub fn default_settings() -> Value {
    json!({
        "schemaVersion": SETTINGS_SCHEMA_VERSION,
        "_version": 0,
        "global": {
            "autoUpdate": true,
            "lastPage": true,
            "rememberSite": true,
            "hideCursor": false,
            "autoFlip": {
                "active": false,
                "interval": 15,
                "keepAwake": true
            }
        },
        "sites": {},
        "pluginConfigs": {}
    })
}

pub fn get_settings_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("settings.json")
}

fn is_current_schema(value: &Value) -> bool {
    value.get("schemaVersion").and_then(Value::as_u64) == Some(SETTINGS_SCHEMA_VERSION)
        && value.get("global").is_some_and(Value::is_object)
        && value.get("sites").is_some_and(Value::is_object)
        && value.get("pluginConfigs").is_some_and(Value::is_object)
        && value.get("_version").and_then(Value::as_u64).is_some()
}

fn read_file(path: &Path) -> Result<Value, String> {
    let file = File::open(path).map_err(|error| format!("Failed to open settings: {error}"))?;
    serde_json::from_reader(BufReader::new(file))
        .map_err(|error| format!("Failed to parse settings: {error}"))
}

fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(source, target).map_err(|error| format!("Failed to replace settings: {error}"))
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let mut source_wide: Vec<u16> = source.as_os_str().encode_wide().collect();
        source_wide.push(0);
        let mut target_wide: Vec<u16> = target.as_os_str().encode_wide().collect();
        target_wide.push(0);
        let result = unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                target_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            Err(format!(
                "Failed to replace settings: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
}

fn atomic_write(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("Settings path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| format!("Failed to create config dir: {error}"))?;
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(".settings.{}.{}.tmp", std::process::id(), sequence));

    let result = (|| {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| format!("Failed to create temporary settings: {error}"))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, value)
            .map_err(|error| format!("Failed to serialize settings: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush settings: {error}"))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|error| format!("Failed to sync settings: {error}"))?;
        drop(writer);
        replace_file(&temp_path, path)?;

        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Failed to sync config directory: {error}"))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn read_or_reset_locked(path: &Path) -> Result<Value, String> {
    if path.exists() {
        if let Ok(value) = read_file(path) {
            if is_current_schema(&value) {
                return Ok(value);
            }
        }
    }
    let settings = default_settings();
    atomic_write(path, &settings)?;
    Ok(settings)
}

impl SettingsRepository {
    fn read_path(path: &Path) -> Result<Value, String> {
        let _guard = SETTINGS_LOCK
            .lock()
            .map_err(|_| "Settings lock poisoned".to_string())?;
        read_or_reset_locked(path)
    }

    fn patch_path(
        path: &Path,
        expected_version: u64,
        patch: &SettingsPatch,
    ) -> Result<PatchOutcome, String> {
        let _guard = SETTINGS_LOCK
            .lock()
            .map_err(|_| "Settings lock poisoned".to_string())?;
        let mut current = read_or_reset_locked(path)?;
        let version = current.get("_version").and_then(Value::as_u64).unwrap_or(0);
        if version != expected_version {
            return Ok(PatchOutcome::Conflict { latest: current });
        }

        apply_patch(&mut current, patch);
        current["schemaVersion"] = json!(SETTINGS_SCHEMA_VERSION);
        let next_version = version.checked_add(1).ok_or("Settings version overflow")?;
        current["_version"] = json!(next_version);
        atomic_write(path, &current)?;
        Ok(PatchOutcome::Applied { settings: current })
    }

    fn update_path(path: &Path, key_path: &str, value: Value) -> Result<Value, String> {
        let _guard = SETTINGS_LOCK
            .lock()
            .map_err(|_| "Settings lock poisoned".to_string())?;
        let mut current = read_or_reset_locked(path)?;
        set_nested_value(
            &mut current,
            &key_path.split('.').collect::<Vec<_>>(),
            value,
        );
        let version = current
            .get("_version")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .checked_add(1)
            .ok_or("Settings version overflow")?;
        current["_version"] = json!(version);
        atomic_write(path, &current)?;
        Ok(current)
    }
}

pub fn read_settings<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    SettingsRepository::read_path(&get_settings_path(app))
}

#[tauri::command]
pub fn get_settings<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    read_settings(&app)
}

fn deep_merge(target: &mut Map<String, Value>, source: &Value) {
    let Some(source) = source.as_object() else {
        return;
    };
    for (key, value) in source {
        if value.is_object() && target.get(key).is_some_and(Value::is_object) {
            if let Some(child) = target.get_mut(key).and_then(Value::as_object_mut) {
                deep_merge(child, value);
            }
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn apply_patch(settings: &mut Value, patch: &SettingsPatch) {
    let object = settings
        .as_object_mut()
        .expect("default settings must be an object");
    for (key, value) in [
        ("global", patch.global.as_ref()),
        ("sites", patch.sites.as_ref()),
        ("pluginConfigs", patch.plugin_configs.as_ref()),
    ] {
        if let Some(value) = value {
            let target = object
                .entry(key.to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(target) = target.as_object_mut() {
                deep_merge(target, value);
            }
        }
    }
}

#[tauri::command]
pub fn patch_settings<R: Runtime>(
    app: AppHandle<R>,
    expected_version: u64,
    patch: SettingsPatch,
) -> Result<PatchOutcome, String> {
    let outcome =
        SettingsRepository::patch_path(&get_settings_path(&app), expected_version, &patch)?;
    let PatchOutcome::Applied { settings: current } = &outcome else {
        return Ok(outcome);
    };
    // 文件已经提交后，事件广播失败不能伪装成保存失败，否则前端回滚会与
    // 磁盘状态产生永久分叉。窗口重载时仍会从 Repository 读到最新状态。
    let _ = app.emit("settings-updated", current);
    Ok(outcome)
}

pub fn update_setting<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    value: Value,
) -> Result<Value, String> {
    let current = SettingsRepository::update_path(&get_settings_path(app), path, value)?;
    let _ = app.emit("settings-updated", &current);
    Ok(current)
}

fn set_nested_value(root: &mut Value, keys: &[&str], value: Value) {
    if keys.is_empty() {
        return;
    }
    if !root.is_object() {
        *root = json!({});
    }
    let object = root.as_object_mut().expect("value initialized as object");
    if keys.len() == 1 {
        object.insert(keys[0].to_string(), value);
        return;
    }
    let child = object
        .entry(keys[0].to_string())
        .or_insert_with(|| json!({}));
    set_nested_value(child, &keys[1..], value);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_settings_path(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "wxrd-settings-test-{label}-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).unwrap();
        directory.join("settings.json")
    }

    fn cleanup(path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn default_document_has_current_schema() {
        assert!(is_current_schema(&default_settings()));
        assert_eq!(default_settings()["global"]["autoUpdate"], true);
        assert_eq!(default_settings()["global"]["autoFlip"]["active"], false);
        assert!(default_settings()["global"].get("enabledPlugins").is_none());
    }

    #[test]
    fn schema_validation_rejects_missing_or_mistyped_sections() {
        let mut cases = Vec::new();
        let mut wrong_version = default_settings();
        wrong_version["schemaVersion"] = json!(1);
        cases.push(wrong_version);
        let mut missing_global = default_settings();
        missing_global.as_object_mut().unwrap().remove("global");
        cases.push(missing_global);
        let mut array_sites = default_settings();
        array_sites["sites"] = json!([]);
        cases.push(array_sites);
        let mut missing_configs = default_settings();
        missing_configs
            .as_object_mut()
            .unwrap()
            .remove("pluginConfigs");
        cases.push(missing_configs);
        let mut invalid_version = default_settings();
        invalid_version["_version"] = json!(-1);
        cases.push(invalid_version);

        for value in cases {
            assert!(
                !is_current_schema(&value),
                "invalid schema accepted: {value}"
            );
        }
    }

    #[test]
    fn patch_preserves_unrelated_sections() {
        let mut value = default_settings();
        value["pluginConfigs"]["demo"] = json!({ "enabled": true });
        apply_patch(
            &mut value,
            &SettingsPatch {
                global: Some(json!({ "hideCursor": true })),
                ..Default::default()
            },
        );
        assert_eq!(value["pluginConfigs"]["demo"]["enabled"], true);
        assert_eq!(value["global"]["hideCursor"], true);
    }

    #[test]
    fn patch_deep_merges_nested_objects_without_replacing_siblings() {
        let mut value = default_settings();
        value["global"]["autoFlip"] = json!({
            "active": false,
            "interval": 15,
            "keepAwake": true
        });
        value["sites"]["weread"] = json!({
            "readerWide": true,
            "zoom": 0.75
        });
        apply_patch(
            &mut value,
            &SettingsPatch {
                global: Some(json!({ "autoFlip": { "active": true } })),
                sites: Some(json!({ "weread": { "zoom": 1.0 } })),
                plugin_configs: Some(json!({ "demo": { "theme": "dark" } })),
            },
        );

        assert_eq!(value["global"]["autoFlip"]["active"], true);
        assert_eq!(value["global"]["autoFlip"]["interval"], 15);
        assert_eq!(value["global"]["autoFlip"]["keepAwake"], true);
        assert_eq!(value["sites"]["weread"]["readerWide"], true);
        assert_eq!(value["sites"]["weread"]["zoom"], 1.0);
        assert_eq!(value["pluginConfigs"]["demo"]["theme"], "dark");
    }

    #[test]
    fn non_object_patch_sections_are_ignored() {
        let mut value = default_settings();
        apply_patch(
            &mut value,
            &SettingsPatch {
                global: Some(json!(["not", "an", "object"])),
                sites: Some(json!(null)),
                plugin_configs: Some(json!(42)),
            },
        );
        assert_eq!(value, default_settings());
    }

    #[test]
    fn repository_resets_old_or_corrupt_documents_without_backup() {
        for (label, content) in [
            ("old", r#"{"schemaVersion":1,"global":{}}"#),
            ("corrupt", "{not-json"),
        ] {
            let path = temporary_settings_path(label);
            let plugin_sentinel = path
                .parent()
                .unwrap()
                .join("plugins")
                .join("keep-installed")
                .join("manifest.json");
            fs::create_dir_all(plugin_sentinel.parent().unwrap()).unwrap();
            fs::write(&plugin_sentinel, "{}").unwrap();
            fs::write(&path, content).unwrap();
            let current = SettingsRepository::read_path(&path).unwrap();
            assert!(is_current_schema(&current));
            assert!(current["global"].get("enabledPlugins").is_none());
            assert!(
                plugin_sentinel.exists(),
                "settings reset must retain plugins"
            );
            let artifacts: Vec<_> = fs::read_dir(path.parent().unwrap())
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|name| name.contains("backup") || name.ends_with(".tmp"))
                .collect();
            assert!(artifacts.is_empty(), "reset must not create backup files");
            cleanup(&path);
        }
    }

    #[test]
    fn repository_serializes_competing_versioned_patches() {
        let path = temporary_settings_path("concurrent");
        SettingsRepository::read_path(&path).unwrap();
        let first_path = path.clone();
        let second_path = path.clone();
        let first = std::thread::spawn(move || {
            SettingsRepository::patch_path(
                &first_path,
                0,
                &SettingsPatch {
                    global: Some(json!({ "hideCursor": true })),
                    ..Default::default()
                },
            )
            .unwrap()
        });
        let second = std::thread::spawn(move || {
            SettingsRepository::patch_path(
                &second_path,
                0,
                &SettingsPatch {
                    global: Some(json!({ "lastPage": false })),
                    ..Default::default()
                },
            )
            .unwrap()
        });
        let outcomes = [first.join().unwrap(), second.join().unwrap()];
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, PatchOutcome::Applied { .. }))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, PatchOutcome::Conflict { .. }))
                .count(),
            1
        );
        assert_eq!(SettingsRepository::read_path(&path).unwrap()["_version"], 1);
        cleanup(&path);
    }

    #[test]
    fn version_conflict_returns_latest_without_writing() {
        let path = temporary_settings_path("conflict-latest");
        let initial = SettingsRepository::read_path(&path).unwrap();
        assert_eq!(initial["_version"], 0);
        let applied = SettingsRepository::patch_path(
            &path,
            0,
            &SettingsPatch {
                global: Some(json!({ "hideCursor": true })),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(matches!(applied, PatchOutcome::Applied { .. }));

        let conflict = SettingsRepository::patch_path(
            &path,
            0,
            &SettingsPatch {
                global: Some(json!({ "lastPage": false })),
                ..Default::default()
            },
        )
        .unwrap();
        let PatchOutcome::Conflict { latest } = conflict else {
            panic!("stale version should conflict");
        };
        assert_eq!(latest["_version"], 1);
        assert_eq!(latest["global"]["hideCursor"], true);
        assert_eq!(latest["global"]["lastPage"], true);
        assert_eq!(SettingsRepository::read_path(&path).unwrap(), latest);
        cleanup(&path);
    }

    #[test]
    fn internal_updates_create_nested_objects_and_increment_version() {
        let path = temporary_settings_path("nested-update");
        SettingsRepository::read_path(&path).unwrap();
        let updated =
            SettingsRepository::update_path(&path, "sites.fanqie.zoom", json!(1.25)).unwrap();
        assert_eq!(updated["sites"]["fanqie"]["zoom"], 1.25);
        assert_eq!(updated["_version"], 1);

        let updated =
            SettingsRepository::update_path(&path, "global.autoFlip.active", json!(true)).unwrap();
        assert_eq!(updated["global"]["autoFlip"]["active"], true);
        assert_eq!(updated["global"]["autoFlip"]["interval"], 15);
        assert_eq!(updated["_version"], 2);
        cleanup(&path);
    }

    #[test]
    fn repository_reads_valid_documents_without_rewriting_them() {
        let path = temporary_settings_path("valid-read");
        let mut expected = default_settings();
        expected["_version"] = json!(9);
        expected["pluginConfigs"]["demo"] = json!({ "value": 7 });
        atomic_write(&path, &expected).unwrap();
        let before = fs::read(&path).unwrap();
        let actual = SettingsRepository::read_path(&path).unwrap();
        let after = fs::read(&path).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(after, before);
        cleanup(&path);
    }

    #[test]
    fn atomic_failure_is_explicit_and_leaves_no_temporary_file() {
        let path = temporary_settings_path("atomic-failure");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("sentinel"), "keep").unwrap();
        assert!(SettingsRepository::read_path(&path).is_err());
        assert!(path.join("sentinel").exists());
        let temporary_files = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_files, 0);
        cleanup(&path);
    }

    #[test]
    fn version_overflow_returns_an_error_without_overwriting() {
        let path = temporary_settings_path("version-overflow");
        let mut current = default_settings();
        current["_version"] = json!(u64::MAX);
        atomic_write(&path, &current).unwrap();
        let result = SettingsRepository::patch_path(
            &path,
            u64::MAX,
            &SettingsPatch {
                global: Some(json!({ "hideCursor": true })),
                ..Default::default()
            },
        );
        assert!(result.is_err());
        let stored = SettingsRepository::read_path(&path).unwrap();
        assert_eq!(stored["_version"], json!(u64::MAX));
        assert_eq!(stored["global"]["hideCursor"], false);
        cleanup(&path);
    }
}
