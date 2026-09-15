//! 菜单动作的稳定契约。
//!
//! 菜单文字和平台呈现会继续演进，但动作 ID 是 Rust、注入脚本、设置深链
//! 与未来自定义菜单 renderer 之间的共同语言。业务代码只应依赖这里的 ID，
//! 不要通过显示文案或一级菜单索引定位项目。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

pub mod id {
    pub const FILE: &str = "menu_file";
    pub const EDIT: &str = "menu_edit";
    pub const READING: &str = "menu_reading";
    pub const GO: &str = "menu_go";
    pub const VIEW: &str = "menu_view";
    pub const WINDOW: &str = "menu_window";
    pub const HELP: &str = "menu_help";
    pub const RECENT: &str = "menu_recent";
    pub const SOURCES: &str = "menu_sources";
    pub const ZOOM: &str = "menu_zoom";
}

pub const READER_ACTION_IDS: &[&str] = &[
    "reader_prev_page",
    "reader_next_page",
    "reader_prev_chapter",
    "reader_next_chapter",
    "auto_flip",
    "reader_style",
    "reader_wide",
    "hide_toolbar",
    "hide_navbar",
];

/// 菜单是否可执行的原生端镜像。前端只负责报告能力，最终执行仍由 Rust 裁决。
/// 默认值为 false，导航开始时也会整体失效，避免旧页面能力泄漏到新页面。
static READER_ACTION_STATE: LazyLock<Mutex<HashMap<&'static str, bool>>> =
    LazyLock::new(|| Mutex::new(READER_ACTION_IDS.iter().map(|id| (*id, false)).collect()));
static FOCUSED_WINDOW: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// 远程/本地页面允许通过 IPC 模拟的有限动作集合。
/// 管理性操作（清理记录、安装/卸载、更新安装、任意外链）不在此列表内。
pub const SIMULATED_ACTION_IDS: &[&str] = &[
    "open_local_book",
    "refresh",
    "back",
    "forward",
    "reader_prev_page",
    "reader_next_page",
    "reader_prev_chapter",
    "reader_next_chapter",
    "reader_style",
    "reader_wide",
    "hide_toolbar",
    "hide_navbar",
    "auto_flip",
    "zoom_in",
    "zoom_out",
    "zoom_reset",
    "toggle_fullscreen",
    "settings",
    "settings_reading",
    "settings_content",
    "settings_data",
    "shortcuts",
    "show_memory",
];

pub const MENU_STATE_IDS: &[&str] = &[
    "reader_wide",
    "hide_toolbar",
    "hide_navbar",
    "auto_flip",
    "reader_prev_page",
    "reader_next_page",
    "reader_prev_chapter",
    "reader_next_chapter",
    "reader_style",
    "zoom_in",
    "zoom_out",
    "zoom_reset",
];

pub fn is_reader_action(id: &str) -> bool {
    READER_ACTION_IDS.contains(&id)
}

pub fn is_simulated_action(id: &str) -> bool {
    SIMULATED_ACTION_IDS.contains(&id)
}

pub fn is_menu_state_id(id: &str) -> bool {
    MENU_STATE_IDS.contains(&id)
}

pub fn set_reader_action_enabled(id: &str, enabled: bool) {
    let Some(stable_id) = READER_ACTION_IDS
        .iter()
        .copied()
        .find(|candidate| *candidate == id)
    else {
        return;
    };
    if let Ok(mut state) = READER_ACTION_STATE.lock() {
        state.insert(stable_id, enabled);
    }
}

pub fn invalidate_reader_actions() {
    if let Ok(mut state) = READER_ACTION_STATE.lock() {
        for id in READER_ACTION_IDS {
            state.insert(*id, false);
        }
    }
}

pub fn is_reader_action_enabled(id: &str) -> bool {
    READER_ACTION_STATE
        .lock()
        .ok()
        .and_then(|state| state.get(id).copied())
        .unwrap_or(false)
}

pub fn set_focused_window(label: Option<&str>) {
    if let Ok(mut focused) = FOCUSED_WINDOW.lock() {
        *focused = label.map(str::to_string);
    }
}

pub fn clear_focused_window_if(label: &str) {
    if let Ok(mut focused) = FOCUSED_WINDOW.lock() {
        if focused.as_deref() == Some(label) {
            *focused = None;
        }
    }
}

pub fn is_main_window_focused() -> bool {
    FOCUSED_WINDOW
        .lock()
        .ok()
        .and_then(|focused| focused.clone())
        .as_deref()
        == Some("main")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_actions_are_stateful_and_simulatable() {
        for id in READER_ACTION_IDS {
            assert!(is_reader_action(id));
            assert!(is_simulated_action(id));
            assert!(is_menu_state_id(id));
        }
    }

    #[test]
    fn simulated_actions_exclude_privileged_or_destructive_operations() {
        for id in [
            "install_plugin",
            "uninstall_plugin",
            "clear_local_history",
            "install_update_now",
            "open_external_url",
        ] {
            assert!(
                !is_simulated_action(id),
                "{id} must stay outside the remote action allowlist"
            );
        }
    }

    #[test]
    fn labels_are_not_part_of_the_stable_menu_contract() {
        assert!(!is_simulated_action("打开本地图书…"));
        assert!(!is_menu_state_id("阅读样式…"));
    }
}
