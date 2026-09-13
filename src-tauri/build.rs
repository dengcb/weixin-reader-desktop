fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=../index.html");
    println!("cargo:rerun-if-changed=../atrd-logo.svg");
    // Tell Cargo to rebuild if inject.js changes
    println!("cargo:rerun-if-changed=../src/scripts/inject.js");
    println!("cargo:rerun-if-changed=../src/scripts/local_reader.js");
    println!("cargo:rerun-if-changed=../src/scripts/local_reader_bootstrap.js");
    println!("cargo:rerun-if-changed=../src/windows/local-reader.html");
    println!("cargo:rerun-if-changed=../src/windows/local-reader.css");
    println!("cargo:rerun-if-changed=../third-party/foliate-js/LICENSE");
    println!("cargo:rerun-if-changed=../THIRD-PARTY-NOTICES.md");
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
            "is_main_fullscreen",
            "reveal_menu_bar_transient",
            "simulate_menu_click",
            "set_content_source_enabled",
            "claim_settings_target",
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
            "get_local_book",
            "get_local_reading_progress",
            "save_local_reading_progress",
            "local_sha1",
            "clear_local_history",
            "check_update_manual",
            "install_update_now",
            "is_update_downloaded",
        ]),
    ))
    .expect("failed to run tauri build");

    // Windows（仅测试配置）：cargo test 的测试宿主 exe（lib target）拿不到
    // tauri_build 的 rustc-link-arg-bins，没有 common-controls v6 manifest 时
    // 加载器把 comctl32 绑到 WinSxS 5.82 旧版，缺少 TaskDialogIndirect 导致
    // STATUS_ENTRYPOINT_NOT_FOUND。若对所有产物重复链接整份 resource.lib，
    // bin 链接会因 VERSION 资源重复报 CVT1100 → LNK1123。
    // 方案：在 debug_assertions（cargo test 走 dev profile）下编译一份只含
    // RT_MANIFEST 的最小资源库 test-manifest.lib，并用 rustc-link-arg 注入。
    // 发版构建（release，无 debug_assertions）完全不执行，不影响安装包。
    #[cfg(all(target_os = "windows", debug_assertions))]
    {
        let out_dir = std::env::var("OUT_DIR")?;
        let dir = std::path::Path::new(&out_dir);
        let rc_path = dir.join("test-manifest.rc");
        let res_path = dir.join("test-manifest.res");
        let lib_path = dir.join("test-manifest.lib");
        if !lib_path.exists() {
            std::fs::write(&rc_path, TEST_MANIFEST_RC)?;
            compile_manifest_library(&rc_path, &res_path, &lib_path)?;
        }
        println!("cargo:rerun-if-changed={}", rc_path.display());
        println!("cargo:rustc-link-arg=/WHOLEARCHIVE:{}", lib_path.display());
    }

    Ok(())
}

/// 仅含 RT_MANIFEST(common-controls v6 依赖) 的最小 .rc。与 tauri_build 的
/// resource.rc 中 manifest 段保持同构（花括号内联数据块——`1 24 "名字"` 形式
/// 会被 rc.exe 当作文件名引用）。别加 VERSIONINFO——正式产物的 VERSION
/// 资源由 tauri_build 的 resource.lib 提供，这里重复会撞 CVT1100。
#[cfg(all(target_os = "windows", debug_assertions))]
const TEST_MANIFEST_RC: &str = "1 24\n{\n\"<assembly xmlns='urn:schemas-microsoft-com:asm.v1' manifestVersion='1.0'>\"\n\"<dependency><dependentAssembly>\"\n\"<assemblyIdentity type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*' />\"\n\"</dependentAssembly></dependency>\"\n\"</assembly>\"\n}\n";

/// 用 Windows SDK 的 rc.exe + MSVC lib.exe 把 .rc 编成只含 manifest 的 COFF 归档库。
/// PATH 优先；探测兜底为当前仓库锁定的 BuildTools 版本路径。
#[cfg(all(target_os = "windows", debug_assertions))]
fn compile_manifest_library(
    rc: &std::path::Path,
    res: &std::path::Path,
    lib: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::process::Command;

    fn find_tool(name: &str, fallback: &str) -> Option<std::path::PathBuf> {
        // fallback 绝对路径优先，再扫描 PATH；coreutils 同名替身
        // （Git Bash /usr/bin/link）靠 Rich-header 签名过滤。
        fn verify(path: &std::path::Path) -> Option<std::path::PathBuf> {
            // MSVC 工具链产物均带 Rich header（加密编译器签名块），
            // coreutils 同名替身（Git Bash /usr/bin/link）没有。
            let Ok(bytes) = std::fs::read(path) else { return None };
            if bytes.starts_with(b"MZ") && bytes.windows(4).any(|w| w == b"Rich") {
                return Some(path.to_path_buf());
            }
            None
        }
        let fallback_path = std::path::PathBuf::from(fallback);
        if let Some(hit) = verify(&fallback_path) {
            return Some(hit);
        }
        if let Ok(env_path) = std::env::var("PATH") {
            for dir in std::env::split_paths(&env_path) {
                let candidate = dir.join(name);
                if let Some(hit) = verify(&candidate) {
                    return Some(hit);
                }
            }
        }
        None
    }

    let rc_exe = find_tool(
        "rc.exe",
        r"C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe",
    )
    .ok_or("test-manifest: rc.exe 不可用（PATH 与 Windows SDK 均未找到）")?;
    let link_exe = find_tool(
        "lib.exe",
        r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\lib.exe",
    )
    .ok_or("test-manifest: lib.exe 不可用（PATH 与 BuildTools 均未找到）")?;

    let status = Command::new(rc_exe)
        .arg("/fo")
        .arg(res)
        .arg(rc)
        .status()
        .map_err(|error| format!("rc.exe 启动失败: {error}"))?;
    if !status.success() {
        return Err("rc.exe 编译 test-manifest.rc 失败".into());
    }

    // lib.exe 把 .res 直接打成 COFF 归档（"<arch>" 头的 .lib）；link.exe
    // 会生成完整 PE 映像（MZ 头），被链接方按归档消费时报 LNK1107。
    let status = Command::new(link_exe)
        .arg("/NOLOGO")
        .arg("/MACHINE:X64")
        .arg(format!("/OUT:{}", lib.display()))
        .arg(res)
        .status()
        .map_err(|error| format!("lib.exe 启动失败: {error}"))?;
    if !status.success() {
        return Err("lib.exe 打包 test-manifest.lib 失败".into());
    }

    let _ = std::fs::remove_file(res);
    Ok(())
}
