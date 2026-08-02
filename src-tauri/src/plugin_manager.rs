use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, Runtime};
use zip::ZipArchive;

const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ARCHIVE_FILES: usize = 128;
const MAX_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024;
static INSTALL_COUNTER: AtomicU64 = AtomicU64::new(0);

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSiteConfig {
    pub domain: Value,
    #[serde(rename = "homeUrl")]
    pub home_url: String,
    #[serde(rename = "readerPattern")]
    pub reader_pattern: String,
}

pub fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    if plugin_id.is_empty()
        || plugin_id.len() > 64
        || plugin_id == "."
        || plugin_id == ".."
        || !plugin_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
    {
        return Err("Invalid plugin ID".to_string());
    }
    Ok(())
}

pub fn validate_plugin_file_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 128
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(format!("Invalid plugin file name: {name}"));
    }
    Ok(())
}

fn validate_plugin_domain(domain: &str) -> Result<(), String> {
    let normalized = domain.strip_prefix("*.").unwrap_or(domain);
    if domain.trim() != domain
        || normalized.is_empty()
        || normalized.len() > 253
        || !normalized.contains('.')
        || normalized.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err(format!("Invalid plugin domain: {domain}"));
    }
    Ok(())
}

pub fn validate_plugin_manifest(manifest: &PluginInfo) -> Result<(), String> {
    validate_plugin_id(&manifest.id)?;
    if manifest.name.trim().is_empty() || manifest.version.trim().is_empty() {
        return Err("Plugin name and version are required".to_string());
    }
    if manifest.source_type == "web" {
        let site = manifest
            .site
            .as_ref()
            .ok_or("Web plugin manifest is missing site configuration")?;
        let domains: Vec<&str> = match &site.domain {
            Value::String(value) => vec![value],
            Value::Array(values) if !values.is_empty() && values.len() <= 32 => values
                .iter()
                .map(|value| value.as_str().ok_or("Plugin domains must be strings"))
                .collect::<Result<_, _>>()?,
            _ => {
                return Err("Plugin domain must be a string or a non-empty string array".to_string())
            }
        };
        for domain in domains {
            validate_plugin_domain(domain)?;
        }
        let home = tauri::Url::parse(&site.home_url)
            .map_err(|_| "Plugin homeUrl must be a valid URL".to_string())?;
        if !matches!(home.scheme(), "https" | "http") || home.host_str().is_none() {
            return Err("Plugin homeUrl must be an HTTP(S) URL".to_string());
        }
        if site.reader_pattern.is_empty() || site.reader_pattern.len() > 1024 {
            return Err("Plugin readerPattern is invalid".to_string());
        }
    }
    Ok(())
}

pub fn manifest_matches_host(plugin: &PluginInfo, host: &str) -> bool {
    let Some(site) = &plugin.site else {
        return false;
    };
    let domains: Vec<&str> = match &site.domain {
        Value::String(value) => vec![value.as_str()],
        Value::Array(values) => values.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    let host = host.to_ascii_lowercase();
    domains.into_iter().any(|domain| {
        let normalized = domain
            .trim()
            .trim_start_matches("*.")
            .trim_start_matches('.')
            .to_ascii_lowercase();
        !normalized.is_empty() && (host == normalized || host.ends_with(&format!(".{normalized}")))
    })
}

pub fn get_plugins_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to get app config dir: {error}"))?;
    Ok(config_dir.join("plugins"))
}

pub fn ensure_plugins_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let plugins_dir = get_plugins_dir(app)?;
    fs::create_dir_all(&plugins_dir)
        .map_err(|error| format!("Failed to create plugins dir: {error}"))?;
    let metadata = fs::symlink_metadata(&plugins_dir)
        .map_err(|error| format!("Failed to inspect plugins dir: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Plugin root must be a real directory".to_string());
    }
    plugins_dir
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize plugins dir: {error}"))
}

pub fn installed_plugin_dir<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    let root = ensure_plugins_dir(app)?;
    let path = root.join(plugin_id);
    if path.exists() {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Failed to inspect plugin: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Installed plugin path must be a real directory".to_string());
        }
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("Failed to canonicalize plugin path: {error}"))?;
        if !canonical.starts_with(&root) {
            return Err("Plugin path escapes plugin root".to_string());
        }
        return Ok(canonical);
    }
    Ok(path)
}

fn validate_archive_path(path: &Path) -> Result<(), String> {
    let mut depth = 0;
    for component in path.components() {
        let Component::Normal(value) = component else {
            return Err("Plugin archive contains an unsafe path".to_string());
        };
        let name = value
            .to_str()
            .ok_or("Plugin archive contains a non-UTF-8 path")?;
        validate_plugin_file_name(name)?;
        depth += 1;
    }
    if depth == 0 || depth > 4 {
        return Err("Plugin archive path is too deeply nested".to_string());
    }
    Ok(())
}

fn is_zip_symlink(mode: Option<u32>) -> bool {
    mode.is_some_and(|value| value & 0o170000 == 0o120000)
}

fn replace_plugin_directory(
    staging: &Path,
    plugin_dir: &Path,
    backup: &Path,
) -> Result<(), String> {
    let had_existing = plugin_dir.exists();
    if had_existing {
        fs::rename(plugin_dir, backup)
            .map_err(|error| format!("Failed to stage existing plugin for replacement: {error}"))?;
    }
    if let Err(error) = fs::rename(staging, plugin_dir) {
        if had_existing {
            let _ = fs::rename(backup, plugin_dir);
        }
        let _ = fs::remove_dir_all(staging);
        return Err(format!("Failed to install validated plugin: {error}"));
    }
    if had_existing {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

fn remove_plugin_directory(plugin_dir: &Path) -> Result<(), String> {
    if plugin_dir.exists() {
        fs::remove_dir_all(plugin_dir)
            .map_err(|error| format!("Failed to remove plugin: {error}"))?;
    }
    Ok(())
}

pub fn inspect_plugin_package(file_path: &str) -> Result<PluginInfo, String> {
    if Path::new(file_path)
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("atrd"))
    {
        return Err("Plugin package must use the .atrd extension".to_string());
    }
    let metadata = fs::metadata(file_path)
        .map_err(|error| format!("Failed to inspect plugin package: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_PACKAGE_BYTES {
        return Err("Plugin package is not a regular file or is too large".to_string());
    }
    let file = fs::File::open(file_path)
        .map_err(|error| format!("Failed to open plugin file: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Failed to read plugin archive: {error}"))?;
    if archive.is_empty() || archive.len() > MAX_ARCHIVE_FILES {
        return Err("Plugin archive has an invalid file count".to_string());
    }

    let mut total_size = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect archive entry: {error}"))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or("Plugin archive contains an unsafe path")?;
        validate_archive_path(&enclosed)?;
        if is_zip_symlink(entry.unix_mode()) {
            return Err("Plugin archive cannot contain symbolic links".to_string());
        }
        if entry.size() > MAX_ENTRY_BYTES {
            return Err("Plugin archive contains an oversized file".to_string());
        }
        total_size = total_size.saturating_add(entry.size());
        if total_size > MAX_ARCHIVE_BYTES {
            return Err("Plugin archive expands beyond the size limit".to_string());
        }
    }

    let mut manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| "Plugin package missing manifest.json")?;
    if manifest_file.size() > 256 * 1024 {
        return Err("Plugin manifest is too large".to_string());
    }
    let mut content = String::new();
    manifest_file
        .read_to_string(&mut content)
        .map_err(|error| format!("Failed to read manifest.json: {error}"))?;
    let manifest: PluginInfo = serde_json::from_str(&content)
        .map_err(|error| format!("Invalid manifest.json: {error}"))?;
    validate_plugin_manifest(&manifest)?;
    Ok(manifest)
}

pub fn install_plugin_from_file<R: Runtime>(
    app: &AppHandle<R>,
    file_path: &str,
) -> Result<PluginInfo, String> {
    let mut manifest = inspect_plugin_package(file_path)?;
    let root = ensure_plugins_dir(app)?;
    let plugin_dir = installed_plugin_dir(app, &manifest.id)?;
    let sequence = INSTALL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let staging = root.join(format!(
        ".install-{}-{}-{sequence}",
        manifest.id,
        std::process::id()
    ));
    let backup = root.join(format!(
        ".backup-{}-{}-{sequence}",
        manifest.id,
        std::process::id()
    ));
    fs::create_dir(&staging)
        .map_err(|error| format!("Failed to create plugin staging directory: {error}"))?;

    let extraction = (|| {
        let package_metadata = fs::metadata(file_path)
            .map_err(|error| format!("Failed to re-inspect plugin package: {error}"))?;
        if !package_metadata.is_file() || package_metadata.len() > MAX_PACKAGE_BYTES {
            return Err("Plugin package changed or exceeds the size limit".to_string());
        }
        let file = fs::File::open(file_path)
            .map_err(|error| format!("Failed to reopen plugin file: {error}"))?;
        let mut archive = ZipArchive::new(file)
            .map_err(|error| format!("Failed to read plugin archive: {error}"))?;
        if archive.is_empty() || archive.len() > MAX_ARCHIVE_FILES {
            return Err("Plugin archive has an invalid file count".to_string());
        }
        let mut total_size = 0_u64;
        let mut extracted_size = 0_u64;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("Failed to read archive entry: {error}"))?;
            let relative = entry
                .enclosed_name()
                .ok_or("Plugin archive contains an unsafe path")?
                .to_path_buf();
            validate_archive_path(&relative)?;
            if is_zip_symlink(entry.unix_mode()) {
                return Err("Plugin archive cannot contain symbolic links".to_string());
            }
            if entry.size() > MAX_ENTRY_BYTES {
                return Err("Plugin archive contains an oversized file".to_string());
            }
            total_size = total_size.saturating_add(entry.size());
            if total_size > MAX_ARCHIVE_BYTES {
                return Err("Plugin archive expands beyond the size limit".to_string());
            }
            let output = staging.join(relative);
            if entry.is_dir() {
                fs::create_dir_all(&output)
                    .map_err(|error| format!("Failed to create plugin directory: {error}"))?;
            } else {
                if let Some(parent) = output.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| format!("Failed to create plugin directory: {error}"))?;
                }
                let mut output_file = fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&output)
                    .map_err(|error| format!("Failed to create plugin file: {error}"))?;
                let copied = io::copy(
                    &mut (&mut entry).take(MAX_ENTRY_BYTES + 1),
                    &mut output_file,
                )
                .map_err(|error| format!("Failed to write plugin file: {error}"))?;
                if copied > MAX_ENTRY_BYTES {
                    return Err("Plugin archive contains an oversized file".to_string());
                }
                extracted_size = extracted_size.saturating_add(copied);
                if extracted_size > MAX_ARCHIVE_BYTES {
                    return Err("Plugin archive expands beyond the size limit".to_string());
                }
                output_file
                    .flush()
                    .map_err(|error| format!("Failed to flush plugin file: {error}"))?;
            }
        }

        let staged_manifest = fs::read_to_string(staging.join("manifest.json"))
            .map_err(|error| format!("Failed to verify staged manifest: {error}"))?;
        let staged_info: PluginInfo = serde_json::from_str(&staged_manifest)
            .map_err(|error| format!("Invalid staged manifest: {error}"))?;
        validate_plugin_manifest(&staged_info)?;
        if staged_info.id != manifest.id {
            return Err("Plugin ID changed during installation".to_string());
        }
        let code = staging.join("plugin.js");
        if !code.is_file()
            || fs::symlink_metadata(&code).is_ok_and(|meta| meta.file_type().is_symlink())
        {
            return Err("Plugin package missing a regular plugin.js".to_string());
        }
        Ok(())
    })();

    if let Err(error) = extraction {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    replace_plugin_directory(&staging, &plugin_dir, &backup)?;

    manifest.enabled = true;
    Ok(manifest)
}

pub fn uninstall_plugin<R: Runtime>(app: &AppHandle<R>, plugin_id: &str) -> Result<(), String> {
    let plugin_dir = installed_plugin_dir(app, plugin_id)?;
    remove_plugin_directory(&plugin_dir)
}

pub fn get_installed_plugins<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<PluginInfo>, String> {
    let root = ensure_plugins_dir(app)?;
    let mut plugins = Vec::new();
    for entry in
        fs::read_dir(&root).map_err(|error| format!("Failed to read plugins dir: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to read plugin entry: {error}"))?;
        let kind = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect plugin entry: {error}"))?;
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let directory_name = entry.file_name();
        let Some(plugin_id) = directory_name.to_str() else {
            continue;
        };
        if validate_plugin_id(plugin_id).is_err() {
            continue;
        }
        let manifest_path = installed_plugin_dir(app, plugin_id)?.join("manifest.json");
        let Ok(metadata) = fs::symlink_metadata(&manifest_path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        let content = fs::read_to_string(&manifest_path)
            .map_err(|error| format!("Failed to read manifest: {error}"))?;
        if let Ok(mut info) = serde_json::from_str::<PluginInfo>(&content) {
            if info.id != plugin_id || validate_plugin_manifest(&info).is_err() {
                continue;
            }
            info.enabled = true;
            plugins.push(info);
        }
    }
    Ok(plugins)
}

pub fn get_plugin_manifest<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
) -> Result<PluginInfo, String> {
    let manifest_path = installed_plugin_dir(app, plugin_id)?.join("manifest.json");
    let metadata = fs::symlink_metadata(&manifest_path)
        .map_err(|error| format!("Failed to inspect manifest: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Plugin manifest must be a regular file".to_string());
    }
    let content = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Failed to read manifest: {error}"))?;
    let manifest: PluginInfo =
        serde_json::from_str(&content).map_err(|error| format!("Invalid manifest: {error}"))?;
    if manifest.id != plugin_id {
        return Err("Installed manifest ID does not match its directory".to_string());
    }
    validate_plugin_manifest(&manifest)?;
    Ok(manifest)
}

pub fn get_plugin_code<R: Runtime>(app: &AppHandle<R>, plugin_id: &str) -> Result<String, String> {
    let code_path = installed_plugin_dir(app, plugin_id)?.join("plugin.js");
    let metadata = fs::symlink_metadata(&code_path)
        .map_err(|_| format!("Plugin code not found for '{plugin_id}'"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Plugin code must be a regular file".to_string());
    }
    fs::read_to_string(&code_path).map_err(|error| format!("Failed to read plugin code: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn web_manifest(domain: Value) -> PluginInfo {
        PluginInfo {
            id: "demo-reader".to_string(),
            name: "Demo Reader".to_string(),
            version: "1.2.3".to_string(),
            description: None,
            author: None,
            homepage: None,
            icon: None,
            source_type: "web".to_string(),
            site: Some(PluginSiteConfig {
                domain,
                home_url: "https://example.com/".to_string(),
                reader_pattern: "/reader/".to_string(),
            }),
            capabilities: None,
            config_schema: None,
            builtin: false,
            enabled: false,
        }
    }

    fn temporary_archive(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "wxrd-plugin-{label}-{}-{}.atrd",
            std::process::id(),
            INSTALL_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn write_archive(path: &Path, files: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut archive = ZipWriter::new(file);
        for (name, content) in files {
            archive
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            archive.write_all(content).unwrap();
        }
        archive.finish().unwrap();
    }

    #[test]
    fn plugin_ids_cannot_escape_root() {
        for value in ["../demo", "/demo", "demo/child", "demo\\child", ".."] {
            assert!(
                validate_plugin_id(value).is_err(),
                "{value} should be rejected"
            );
        }
        assert!(validate_plugin_id("fanqie-reader_2").is_ok());
        assert!(validate_plugin_id("").is_err());
        assert!(validate_plugin_id("Uppercase").is_err());
        assert!(validate_plugin_id(&"a".repeat(65)).is_err());
        assert!(validate_plugin_id(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn editor_file_names_are_flat_and_portable() {
        assert!(validate_plugin_file_name("theme.css").is_ok());
        assert!(validate_plugin_file_name("../theme.css").is_err());
        assert!(validate_plugin_file_name("styles/theme.css").is_err());
        assert!(validate_plugin_file_name("plugin name.js").is_err());
        assert!(validate_plugin_file_name(&"a".repeat(129)).is_err());
        assert!(validate_plugin_file_name("plugin.min-2_js").is_ok());
    }

    #[test]
    fn domains_cannot_expand_to_an_entire_public_suffix() {
        assert!(validate_plugin_domain("fanqienovel.com").is_ok());
        assert!(validate_plugin_domain("*.example.com").is_ok());
        for value in [
            "com",
            "https://example.com",
            "../example.com",
            ".example.com",
            "-bad.example.com",
            "bad-.example.com",
            " example.com",
        ] {
            assert!(
                validate_plugin_domain(value).is_err(),
                "{value} should be rejected"
            );
        }
    }

    #[test]
    fn web_manifest_validation_covers_required_site_contract() {
        assert!(validate_plugin_manifest(&web_manifest(json!("example.com"))).is_ok());
        assert!(
            validate_plugin_manifest(&web_manifest(json!(["example.com", "*.reader.test"])))
                .is_ok()
        );

        let mut missing_site = web_manifest(json!("example.com"));
        missing_site.site = None;
        assert!(validate_plugin_manifest(&missing_site).is_err());

        let mut empty_name = web_manifest(json!("example.com"));
        empty_name.name = "  ".to_string();
        assert!(validate_plugin_manifest(&empty_name).is_err());

        let mut non_http = web_manifest(json!("example.com"));
        non_http.site.as_mut().unwrap().home_url = "file:///tmp/book".to_string();
        assert!(validate_plugin_manifest(&non_http).is_err());

        let mut empty_pattern = web_manifest(json!("example.com"));
        empty_pattern.site.as_mut().unwrap().reader_pattern.clear();
        assert!(validate_plugin_manifest(&empty_pattern).is_err());

        assert!(validate_plugin_manifest(&web_manifest(json!([]))).is_err());
        assert!(validate_plugin_manifest(&web_manifest(json!(["example.com", 7]))).is_err());
        assert!(validate_plugin_manifest(&web_manifest(json!(vec!["a.example.com"; 33]))).is_err());

        let mut local = web_manifest(json!(null));
        local.source_type = "local".to_string();
        local.site = None;
        assert!(validate_plugin_manifest(&local).is_ok());
    }

    #[test]
    fn host_matching_is_case_insensitive_and_label_bounded() {
        let plugin = web_manifest(json!(["Example.COM", "*.Reader.Example.NET"]));
        assert!(manifest_matches_host(&plugin, "EXAMPLE.COM"));
        assert!(manifest_matches_host(&plugin, "book.example.com"));
        assert!(manifest_matches_host(&plugin, "reader.example.net"));
        assert!(manifest_matches_host(&plugin, "a.reader.example.net"));
        assert!(!manifest_matches_host(&plugin, "evilexample.com"));
        assert!(!manifest_matches_host(&plugin, "example.com.attacker.test"));

        let mut without_site = plugin.clone();
        without_site.site = None;
        assert!(!manifest_matches_host(&without_site, "example.com"));
    }

    #[test]
    fn valid_package_inspection_returns_the_validated_manifest() {
        let path = temporary_archive("valid");
        let manifest = serde_json::to_vec(&web_manifest(json!("example.com"))).unwrap();
        write_archive(
            &path,
            &[
                ("manifest.json", &manifest),
                ("plugin.js", b"export default class Demo {}"),
            ],
        );

        let inspected = inspect_plugin_package(path.to_str().unwrap()).unwrap();
        assert_eq!(inspected.id, "demo-reader");
        assert_eq!(inspected.site.unwrap().home_url, "https://example.com/");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn package_inspection_rejects_wrong_extension_empty_zip_and_missing_manifest() {
        let wrong_extension = std::env::temp_dir().join(format!(
            "wxrd-plugin-wrong-{}-{}.zip",
            std::process::id(),
            INSTALL_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&wrong_extension, b"not used").unwrap();
        assert!(inspect_plugin_package(wrong_extension.to_str().unwrap()).is_err());
        let _ = fs::remove_file(wrong_extension);

        let empty = temporary_archive("empty");
        ZipWriter::new(fs::File::create(&empty).unwrap())
            .finish()
            .unwrap();
        assert!(inspect_plugin_package(empty.to_str().unwrap()).is_err());
        let _ = fs::remove_file(empty);

        let missing = temporary_archive("missing-manifest");
        write_archive(&missing, &[("plugin.js", b"export default {}")]);
        assert!(inspect_plugin_package(missing.to_str().unwrap()).is_err());
        let _ = fs::remove_file(missing);
    }

    #[test]
    fn package_inspection_rejects_oversized_entries_and_deep_paths() {
        let oversized = temporary_archive("oversized-entry");
        let content = vec![b'x'; MAX_ENTRY_BYTES as usize + 1];
        write_archive(&oversized, &[("large.js", &content)]);
        assert!(inspect_plugin_package(oversized.to_str().unwrap()).is_err());
        let _ = fs::remove_file(oversized);

        let deep = temporary_archive("deep-path");
        write_archive(&deep, &[("a/b/c/d/e.js", b"deep")]);
        assert!(inspect_plugin_package(deep.to_str().unwrap()).is_err());
        let _ = fs::remove_file(deep);
    }

    #[test]
    fn abnormal_archive_paths_are_rejected() {
        let path = std::env::temp_dir().join(format!(
            "wxrd-malformed-plugin-{}-{}.atrd",
            std::process::id(),
            INSTALL_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let file = fs::File::create(&path).unwrap();
        let mut archive = ZipWriter::new(file);
        archive
            .start_file("../escape.js", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"escape").unwrap();
        archive.finish().unwrap();
        assert!(inspect_plugin_package(path.to_str().unwrap()).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn archive_file_count_limit_is_enforced() {
        let path = std::env::temp_dir().join(format!(
            "wxrd-too-many-plugin-files-{}-{}.atrd",
            std::process::id(),
            INSTALL_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let file = fs::File::create(&path).unwrap();
        let mut archive = ZipWriter::new(file);
        for index in 0..=MAX_ARCHIVE_FILES {
            archive
                .start_file(format!("file-{index}.js"), SimpleFileOptions::default())
                .unwrap();
        }
        archive.finish().unwrap();
        assert!(inspect_plugin_package(path.to_str().unwrap()).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn zip_symbolic_links_are_rejected() {
        assert!(is_zip_symlink(Some(0o120777)));
        assert!(!is_zip_symlink(Some(0o100644)));
        assert!(!is_zip_symlink(None));
    }

    #[test]
    fn failed_replacement_restores_the_previous_plugin() {
        let root = std::env::temp_dir().join(format!(
            "wxrd-plugin-rollback-{}-{}",
            std::process::id(),
            INSTALL_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let plugin_dir = root.join("plugins").join("fanqie");
        let missing_staging = root.join("plugins").join("missing-staging");
        let backup = root.join("plugins").join("backup");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(plugin_dir.join("plugin.js"), "old").unwrap();

        assert!(replace_plugin_directory(&missing_staging, &plugin_dir, &backup).is_err());
        assert_eq!(
            fs::read_to_string(plugin_dir.join("plugin.js")).unwrap(),
            "old"
        );
        assert!(!backup.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn successful_replacement_removes_old_version_and_backup() {
        let root = std::env::temp_dir().join(format!(
            "wxrd-plugin-success-{}-{}",
            std::process::id(),
            INSTALL_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let plugin_dir = root.join("plugins").join("fanqie");
        let staging = root.join("plugins").join("staging");
        let backup = root.join("plugins").join("backup");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(plugin_dir.join("plugin.js"), "old").unwrap();
        fs::write(staging.join("plugin.js"), "new").unwrap();

        replace_plugin_directory(&staging, &plugin_dir, &backup).unwrap();
        assert_eq!(
            fs::read_to_string(plugin_dir.join("plugin.js")).unwrap(),
            "new"
        );
        assert!(!staging.exists());
        assert!(!backup.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn uninstall_keeps_reading_progress_outside_the_plugin_root() {
        let root = std::env::temp_dir().join(format!(
            "wxrd-plugin-progress-{}-{}",
            std::process::id(),
            INSTALL_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let plugin_dir = root.join("plugins").join("fanqie");
        let progress_file = root
            .join("reading-progress")
            .join("fanqie")
            .join("url-hash.json");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::create_dir_all(progress_file.parent().unwrap()).unwrap();
        fs::write(plugin_dir.join("plugin.js"), "plugin").unwrap();
        fs::write(&progress_file, "123").unwrap();

        remove_plugin_directory(&plugin_dir).unwrap();
        assert!(!plugin_dir.exists());
        assert_eq!(fs::read_to_string(&progress_file).unwrap(), "123");
        let _ = fs::remove_dir_all(root);
    }
}
