fn main() {
    // Tell Cargo to rebuild if inject.js changes
    println!("cargo:rerun-if-changed=../src/scripts/inject.js");
    // Tauri 会在编译期把 frontendDist 的资源嵌入应用；默认页新增或更新后必须
    // 重新运行 build.rs，否则正在构建的壳找不到 library.html。
    println!("cargo:rerun-if-changed=../dist/library.html");

    // Tauri 2.11+ 要求注册自定义命令到 AppManifest，
    // 否则远程 URL（如 weread.qq.com）的 invoke 调用会被 ACL 拒绝。
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "log_to_file",
            "update_menu_state",
            "set_menu_item_enabled",
            "set_active_bookstore",
            "set_title",
            "toggle_stealth",
            "toggle_menu_bar",
            "simulate_menu_click",
            "switch_bookstore_by_index",
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
            "prepare_plugin_install",
            "get_pending_plugin_install",
            "confirm_pending_plugin_install",
            "cancel_pending_plugin_install",
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
