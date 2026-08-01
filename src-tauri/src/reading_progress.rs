use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const MAX_POSITIONS_PER_SITE: usize = 10_000;
static POSITION_LOCK: Mutex<()> = Mutex::new(());
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Serialize)]
struct ReadingPosition {
    position: f64,
}

fn validate_site_id(site_id: &str) -> Result<(), String> {
    if site_id.is_empty()
        || site_id.len() > 64
        || !site_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
    {
        return Err("Invalid site ID".to_string());
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<(), String> {
    if url.len() > 4096 || !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Invalid reading URL".to_string());
    }
    Ok(())
}

fn url_hash(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn site_directory<R: Runtime>(app: &AppHandle<R>, site_id: &str) -> Result<PathBuf, String> {
    validate_site_id(site_id)?;
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to resolve config directory: {error}"))?
        .join("reading-progress")
        .join(site_id))
}

fn position_path<R: Runtime>(
    app: &AppHandle<R>,
    site_id: &str,
    url: &str,
) -> Result<PathBuf, String> {
    validate_url(url)?;
    Ok(site_directory(app, site_id)?.join(format!("{}.json", url_hash(url))))
}

fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(source, target).map_err(|error| format!("Failed to replace position: {error}"))
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
                "Failed to replace position: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
}

fn write_position(path: &Path, value: &ReadingPosition) -> Result<(), String> {
    let directory = path.parent().ok_or("Reading position path has no parent")?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to create reading position directory: {error}"))?;
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(".position.{}.{}.tmp", std::process::id(), sequence));

    let result = (|| {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("Failed to create temporary position: {error}"))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer(&mut writer, value)
            .map_err(|error| format!("Failed to serialize position: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush position: {error}"))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|error| format!("Failed to sync position: {error}"))?;
        drop(writer);
        replace_file(&temporary, path)?;
        #[cfg(unix)]
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Failed to sync reading position directory: {error}"))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn can_create_position(existing_entry: bool, stored_count: usize) -> bool {
    existing_entry || stored_count < MAX_POSITIONS_PER_SITE
}

fn validate_runtime_scope<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    site_id: &str,
    reading_url: &str,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Reading positions are only available to the main window".to_string());
    }
    let current_url = window
        .url()
        .map_err(|error| format!("Failed to read window URL: {error}"))?;
    let requested_url =
        tauri::Url::parse(reading_url).map_err(|_| "Invalid reading URL".to_string())?;
    if !matches!(current_url.scheme(), "https" | "http")
        || !matches!(requested_url.scheme(), "https" | "http")
    {
        return Err("Invalid reading URL scheme".to_string());
    }
    let current_host = current_url.host_str().ok_or("Current URL has no host")?;
    let requested_host = requested_url.host_str().ok_or("Reading URL has no host")?;

    let allowed = if site_id == crate::sites::WEREAD.id {
        [current_host, requested_host]
            .into_iter()
            .all(|host| host == "weread.qq.com" || host.ends_with(".weread.qq.com"))
    } else {
        crate::plugin_manager::get_installed_plugins(app)?
            .into_iter()
            .find(|plugin| plugin.id == site_id)
            .is_some_and(|plugin| {
                crate::plugin_manager::manifest_matches_host(&plugin, current_host)
                    && crate::plugin_manager::manifest_matches_host(&plugin, requested_host)
            })
    };
    if !allowed {
        return Err("Reading position scope does not match the current site".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn get_reading_position<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    site_id: String,
    url: String,
) -> Result<Option<f64>, String> {
    validate_runtime_scope(&app, &window, &site_id, &url)?;
    let _guard = POSITION_LOCK
        .lock()
        .map_err(|_| "Reading position lock poisoned".to_string())?;
    let path = position_path(&app, &site_id, &url)?;
    if !path.exists() {
        return Ok(None);
    }
    let file = File::open(path).map_err(|error| format!("Failed to open position: {error}"))?;
    let value: ReadingPosition = serde_json::from_reader(BufReader::new(file))
        .map_err(|error| format!("Failed to parse position: {error}"))?;
    if !value.position.is_finite() || value.position < 0.0 {
        return Err("Invalid saved reading position".to_string());
    }
    Ok(Some(value.position))
}

#[tauri::command]
pub fn save_reading_position<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    site_id: String,
    url: String,
    position: f64,
) -> Result<(), String> {
    validate_runtime_scope(&app, &window, &site_id, &url)?;
    if !position.is_finite() || position < 0.0 || position > 1_000_000_000.0 {
        return Err("Invalid reading position".to_string());
    }
    let _guard = POSITION_LOCK
        .lock()
        .map_err(|_| "Reading position lock poisoned".to_string())?;
    let path = position_path(&app, &site_id, &url)?;
    let directory = path.parent().ok_or("Reading position path has no parent")?;

    if !path.exists() && directory.exists() {
        let count = fs::read_dir(directory)
            .map_err(|error| format!("Failed to inspect reading positions: {error}"))?
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                    && entry.file_type().is_ok_and(|kind| kind.is_file())
            })
            .take(MAX_POSITIONS_PER_SITE)
            .count();
        if !can_create_position(false, count) {
            return Err("Reading position limit reached for this site".to_string());
        }
    }

    write_position(&path, &ReadingPosition { position })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_position_path(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "wxrd-position-test-{label}-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        directory.join("reading-progress/fanqie/value.json")
    }

    #[test]
    fn url_hash_is_stable_and_distinct() {
        let hash = url_hash("https://example.com/a");
        assert_eq!(hash, url_hash("https://example.com/a"));
        assert_ne!(hash, url_hash("https://example.com/b"));
        assert_eq!(hash.len(), 64);
        assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn rejects_path_like_site_ids() {
        assert!(validate_site_id("../demo").is_err());
        assert!(validate_site_id("/demo").is_err());
        assert!(validate_site_id("demo\\child").is_err());
        assert!(validate_site_id("fanqie").is_ok());
        assert!(validate_site_id("").is_err());
        assert!(validate_site_id("Uppercase").is_err());
        assert!(validate_site_id(&"a".repeat(65)).is_err());
        assert!(validate_site_id(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn reading_urls_must_be_bounded_http_urls() {
        assert!(validate_url("https://example.com/book").is_ok());
        assert!(validate_url("http://localhost/book").is_ok());
        assert!(validate_url("file:///tmp/book").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url(&format!("https://example.com/{}", "x".repeat(4097))).is_err());
    }

    #[test]
    fn position_entries_are_independent_small_files() {
        let first = temporary_position_path("independent");
        let second = first.with_file_name("other.json");
        write_position(&first, &ReadingPosition { position: 12.5 }).unwrap();
        write_position(&second, &ReadingPosition { position: 99.0 }).unwrap();
        let first_value: ReadingPosition =
            serde_json::from_reader(BufReader::new(File::open(&first).unwrap())).unwrap();
        let second_value: ReadingPosition =
            serde_json::from_reader(BufReader::new(File::open(&second).unwrap())).unwrap();
        assert_eq!(first_value.position, 12.5);
        assert_eq!(second_value.position, 99.0);
        let root = first.ancestors().nth(3).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn position_write_atomically_replaces_existing_value_without_temp_artifacts() {
        let path = temporary_position_path("replace");
        write_position(&path, &ReadingPosition { position: 1.0 }).unwrap();
        write_position(&path, &ReadingPosition { position: 2.5 }).unwrap();
        let value: ReadingPosition =
            serde_json::from_reader(BufReader::new(File::open(&path).unwrap())).unwrap();
        assert_eq!(value.position, 2.5);
        let temporary_count = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_count, 0);
        let root = path.ancestors().nth(3).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_position_replacement_keeps_target_and_removes_temporary_file() {
        let path = temporary_position_path("atomic-failure");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("sentinel"), "keep").unwrap();
        let result = write_position(&path, &ReadingPosition { position: 8.0 });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(path.join("sentinel")).unwrap(), "keep");
        let temporary_count = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_count, 0);
        let root = path.ancestors().nth(3).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn position_limit_allows_updates_but_rejects_new_overflow() {
        assert!(can_create_position(false, 0));
        assert!(can_create_position(false, MAX_POSITIONS_PER_SITE - 1));
        assert!(!can_create_position(false, MAX_POSITIONS_PER_SITE));
        assert!(can_create_position(true, MAX_POSITIONS_PER_SITE));
        assert!(can_create_position(true, usize::MAX));
    }

    #[test]
    fn runtime_scope_accepts_weread_subdomains_and_rejects_cross_site_access() {
        let app = tauri::test::mock_app();
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://weread.qq.com/web/reader/book".parse().unwrap()),
        )
        .build()
        .unwrap();
        assert!(validate_runtime_scope(
            app.handle(),
            &main,
            "weread",
            "https://weread.qq.com/web/reader/other"
        )
        .is_ok());
        assert!(validate_runtime_scope(
            app.handle(),
            &main,
            "weread",
            "https://evil.example/web/reader/book"
        )
        .is_err());

        let settings = tauri::WebviewWindowBuilder::new(
            &app,
            "settings",
            tauri::WebviewUrl::External("https://weread.qq.com/".parse().unwrap()),
        )
        .build()
        .unwrap();
        assert!(validate_runtime_scope(
            app.handle(),
            &settings,
            "weread",
            "https://weread.qq.com/web/reader/book"
        )
        .is_err());
    }
}
