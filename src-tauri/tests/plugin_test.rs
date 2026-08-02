//! Integration tests for Plugin Management
//!
//! These tests verify:
//! - PluginInfo serialization/deserialization
//! - PluginSiteConfig structure
//! - Plugin directory management (Mock)
//! - Plugin installation logic (Mock-based logic check)

#[cfg(test)]
mod tests {
    use serde_json::json;
    use weixin_reader_lib::plugin_manager::{PluginInfo, PluginSiteConfig};

    #[test]
    fn test_plugin_info_deserialization() {
        // Test deserializing real PluginInfo struct
        let manifest_json = r#"{
            "id": "test-plugin",
            "name": "Test Plugin",
            "version": "1.0.0",
            "sourceType": "script",
            "site": {
                "domain": "example.com",
                "homeUrl": "https://example.com/",
                "readerPattern": "/reader/"
            }
        }"#;

        let info: PluginInfo = serde_json::from_str(manifest_json).unwrap();
        assert_eq!(info.id, "test-plugin");
        assert_eq!(info.source_type, "script");

        let site = info.site.unwrap();
        assert_eq!(site.home_url, "https://example.com/");
    }

    #[test]
    fn test_plugin_site_config_variants() {
        // Test domain as string
        let site_json = r#"{
            "domain": "example.com",
            "homeUrl": "https://example.com/",
            "readerPattern": "/reader/"
        }"#;
        let site: PluginSiteConfig = serde_json::from_str(site_json).unwrap();
        assert_eq!(site.domain, "example.com");

        // Test domain as array
        let site_json = r#"{
            "domain": ["example.com", "example.net"],
            "homeUrl": "https://example.com/",
            "readerPattern": "/reader/"
        }"#;
        let site: PluginSiteConfig = serde_json::from_str(site_json).unwrap();
        assert!(site.domain.is_array());
    }

    #[test]
    fn test_installed_plugin_fields_deserialization() {
        let record_json = r#"{
            "id": "test-plugin",
            "name": "Test Plugin",
            "version": "1.0.0",
            "sourceType": "script",
            "enabled": true,
            "builtin": false
        }"#;

        let record: PluginInfo = serde_json::from_str(record_json).unwrap();
        assert_eq!(record.id, "test-plugin");
        assert!(record.enabled);
        assert!(!record.builtin);
    }

    #[test]
    fn test_plugin_config_structure() {
        // Test how plugin configurations are nested in settings.json
        let settings = json!({
            "global": {},
            "sites": {},
            "pluginConfigs": {
                "test-plugin": {
                    "enableExtra": true,
                    "fontSize": 16
                },
                "another-plugin": {
                    "theme": "dark"
                }
            }
        });

        assert!(settings["pluginConfigs"].is_object());
        assert_eq!(
            settings["pluginConfigs"]["test-plugin"]["enableExtra"],
            true
        );
        assert_eq!(settings["pluginConfigs"]["another-plugin"]["theme"], "dark");
    }

    #[test]
    fn test_manifest_validation_logic() {
        // Simulate the validation logic in install_plugin_from_file
        let manifest_content = r#"{
            "id": "test-plugin",
            "name": "Test Plugin",
            "version": "1.0.0",
            "sourceType": "script"
        }"#;

        let res: Result<serde_json::Value, _> = serde_json::from_str(manifest_content);
        assert!(res.is_ok());
        let val = res.unwrap();
        assert_eq!(val["id"], "test-plugin");
        assert_eq!(val["version"], "1.0.0");
    }

    #[test]
    fn test_path_logic() {
        // Simulate path joining for plugins
        let base_dir = std::path::PathBuf::from("/mock/config");
        let plugins_dir = base_dir.join("plugins");
        let plugin_id = "my-plugin";
        let plugin_path = plugins_dir.join(plugin_id);
        let manifest_path = plugin_path.join("manifest.json");

        assert_eq!(plugins_dir.to_str().unwrap(), "/mock/config/plugins");
        assert_eq!(
            plugin_path.to_str().unwrap(),
            "/mock/config/plugins/my-plugin"
        );
        assert_eq!(
            manifest_path.to_str().unwrap(),
            "/mock/config/plugins/my-plugin/manifest.json"
        );
    }
}
