
## Windows（已知问题）
- dev profile `cargo build/test` 存在 LNK1241：bin 目标同时链 tauri_build 的 resource.lib 与测试宿主 test-manifest.lib（两者各含 ID=1 的 RT_MANIFEST）。release 不受影响（无 debug_assertions）。在 Windows 上请使用 `cargo test --lib`；根因修复已列入队列（build.rs 注入需排除 bin 目标）。
