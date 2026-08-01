fn main() {
    // Tell Cargo to rebuild if inject.js changes
    println!("cargo:rerun-if-changed=../src/scripts/inject.js");

    // Tauri 2.11+ 要求注册自定义命令到 AppManifest，
    // 否则远程 URL（如 weread.qq.com）的 invoke 调用会被 ACL 拒绝。
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "log_to_file",
            "update_menu_state",
            "set_menu_item_enabled",
            "set_active_bookstore",
            "set_title",
            "apply_site_zoom",
            "get_app_name",
            "get_app_version",
            "install_plugin",
            "uninstall_plugin",
            "get_installed_plugins",
            "get_runtime_plugin",
            "load_plugin_for_edit",
            "save_plugin",
            "export_plugin",
            "install_plugin_from_editor",
            "get_settings",
            "patch_settings",
            "get_reading_position",
            "save_reading_position",
            "check_update_manual",
            "install_update_now",
            "is_update_downloaded",
        ]),
    ))
    .expect("failed to run tauri build");
}
