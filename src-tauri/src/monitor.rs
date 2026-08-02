//! Multi-monitor support module
//!
//! This module provides functionality for:
//! - Detecting the current monitor (display) where the window is located
//! - Getting macOS system display names
//! - Building menu items for moving window between monitors
//! - Event-driven window position monitoring (no polling)

#![allow(deprecated)]
#![allow(non_camel_case_types, non_upper_case_globals)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Runtime, Size, WebviewWindow,
};

#[cfg(target_os = "macos")]
use objc::runtime::Object;
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};
#[cfg(target_os = "macos")]
type id = *mut Object;
#[cfg(target_os = "macos")]
const nil: id = std::ptr::null_mut();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Rect {
    fn from_parts(position: &PhysicalPosition<i32>, size: &PhysicalSize<u32>) -> Self {
        Self {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        }
    }
}

fn monitor_index_from_native(current: Rect, monitors: &[Rect]) -> Option<usize> {
    monitors.iter().position(|monitor| *monitor == current)
}

fn map_axis(
    window_origin: i32,
    window_length: u32,
    source_origin: i32,
    source_length: u32,
    target_origin: i32,
    target_length: u32,
) -> (i32, u32) {
    if source_length == 0 || target_length == 0 {
        return (target_origin, target_length);
    }

    let length_ratio = window_length as f64 / source_length as f64;
    let target_window_length =
        ((target_length as f64 * length_ratio).round() as u32).clamp(1, target_length);

    let source_travel = source_length.saturating_sub(window_length);
    let anchor = if source_travel == 0 {
        0.5
    } else {
        ((window_origin as f64 - source_origin as f64) / source_travel as f64).clamp(0.0, 1.0)
    };
    let target_travel = target_length.saturating_sub(target_window_length);
    let target_window_origin = target_origin as f64 + (target_travel as f64 * anchor).round();

    (target_window_origin as i32, target_window_length)
}

/// 将普通窗口在源显示器工作区中的尺寸比例和位置锚点映射到目标工作区。
fn map_window_to_work_area(window: Rect, source: Rect, target: Rect) -> Rect {
    let (x, width) = map_axis(
        window.x,
        window.width,
        source.x,
        source.width,
        target.x,
        target.width,
    );
    let (y, height) = map_axis(
        window.y,
        window.height,
        source.y,
        source.height,
        target.y,
        target.height,
    );
    Rect {
        x,
        y,
        width,
        height,
    }
}

/// 从 Rust 字符串创建 NSString（通过 objc msg_send，不依赖 cocoa crate）
#[cfg(target_os = "macos")]
fn ns_string(s: &str) -> id {
    let c_str = std::ffi::CString::new(s).unwrap();
    unsafe { msg_send![class!(NSString), stringWithUTF8String: c_str.as_ptr()] }
}

/// Get the index of the monitor (display) where the main window is currently located.
///
/// 使用 Tauri 2.11 的 `current_monitor()` 获取窗口所属显示器。
///
/// # Returns
/// * `Some(usize)` - The index of the monitor containing the window
/// * `None` - Unable to determine the monitor (window not found or position unavailable)
pub fn get_current_monitor_index<R: Runtime>(handle: &AppHandle<R>) -> Option<usize> {
    let window = handle.get_webview_window("main")?;
    let monitors = window.available_monitors().ok()?;
    let monitor_bounds: Vec<_> = monitors
        .iter()
        .map(|monitor| Rect::from_parts(monitor.position(), monitor.size()))
        .collect();

    let current = window.current_monitor().ok()??;
    monitor_index_from_native(
        Rect::from_parts(current.position(), current.size()),
        &monitor_bounds,
    )
}

/// Get macOS system display names (e.g., "P275MV", "G1").
///
/// This function uses NSScreen API to get user-defined display names from System Preferences.
/// The order matches Tauri's available_monitors() order.
///
/// # Returns
/// A vector of display names in the same order as available_monitors()
#[cfg(target_os = "macos")]
pub fn get_macos_display_names() -> Vec<String> {
    use std::ffi::CStr;
    let mut display_names = Vec::new();

    unsafe {
        let screens_class = class!(NSScreen);
        let screens: id = msg_send![screens_class, screens];
        let count: usize = msg_send![screens, count];

        for i in 0..count {
            let screen: id = msg_send![screens, objectAtIndex: i];

            // Try to get localizedName (macOS 10.15+)
            let localized_name: id = msg_send![screen, localizedName];

            if localized_name != nil {
                let utf8: *const i8 = msg_send![localized_name, UTF8String];

                if !utf8.is_null() {
                    if let Ok(s) = CStr::from_ptr(utf8).to_str() {
                        if !s.is_empty() {
                            display_names.push(s.to_string());
                            continue;
                        }
                    }
                }
            }

            // Fallback: Try deviceDescription
            let device_description: id = msg_send![screen, deviceDescription];
            let name_key: id = ns_string("NSDeviceName");
            let device_name: id = msg_send![device_description, objectForKey: name_key];

            if device_name != nil {
                let utf8: *const i8 = msg_send![device_name, UTF8String];
                if !utf8.is_null() {
                    if let Ok(s) = CStr::from_ptr(utf8).to_str() {
                        display_names.push(s.to_string());
                        continue;
                    }
                }
            }

            // Last resort: use a generic name
            let generic_name = format!("显示器 {}", i + 1);
            display_names.push(generic_name);
        }
    }

    display_names
}

/// Get display names for non-macOS platforms.
/// Uses Tauri's monitor API to get names, falling back to generic names.
#[cfg(not(target_os = "macos"))]
pub fn get_display_names<R: Runtime>(handle: &AppHandle<R>) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(monitors) = handle.available_monitors() {
        for (i, monitor) in monitors.iter().enumerate() {
            if let Some(name) = monitor.name() {
                names.push(name.to_string());
            } else {
                names.push(format!("Monitor {}", i + 1));
            }
        }
    }
    if names.is_empty() {
        names.push("Monitor 1".to_string());
    }
    names
}

fn apply_window_rect<R: Runtime>(window: &WebviewWindow<R>, rect: Rect) -> tauri::Result<()> {
    window.set_position(Position::Physical(PhysicalPosition::new(rect.x, rect.y)))?;
    window.set_size(Size::Physical(PhysicalSize::new(rect.width, rect.height)))
}

fn wait_for_restored_window<R: Runtime>(
    window: &WebviewWindow<R>,
    was_fullscreen: bool,
    was_maximized: bool,
) {
    for _ in 0..30 {
        let fullscreen_ready = !was_fullscreen || matches!(window.is_fullscreen(), Ok(false));
        let maximized_ready = !was_maximized || matches!(window.is_maximized(), Ok(false));
        if fullscreen_ready && maximized_ready {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn wait_for_target_monitor<R: Runtime>(handle: &AppHandle<R>, target_index: usize) {
    for _ in 0..20 {
        if get_current_monitor_index(handle) == Some(target_index) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// 将主窗口移动到目标显示器，并保留全屏/最大化状态或普通窗口比例。
pub fn move_main_window_to_monitor<R: Runtime>(
    handle: &AppHandle<R>,
    target_index: usize,
) -> Result<(), String> {
    let window = handle
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let current_index = get_current_monitor_index(handle)
        .ok_or_else(|| "Tauri current_monitor could not identify the source display".to_string())?;
    if current_index == target_index {
        return Ok(());
    }

    let source_monitor = monitors
        .get(current_index)
        .ok_or_else(|| "Source display index is no longer valid".to_string())?;
    let target_monitor = monitors
        .get(target_index)
        .ok_or_else(|| "Target display index is no longer valid".to_string())?;

    let window_rect = Rect::from_parts(
        &window.outer_position().map_err(|error| error.to_string())?,
        &window.outer_size().map_err(|error| error.to_string())?,
    );
    let source_work_area = Rect::from_parts(
        &source_monitor.work_area().position,
        &source_monitor.work_area().size,
    );
    let target_work_area = Rect::from_parts(
        &target_monitor.work_area().position,
        &target_monitor.work_area().size,
    );
    let target_rect = map_window_to_work_area(window_rect, source_work_area, target_work_area);

    let was_fullscreen = window.is_fullscreen().unwrap_or(false);
    let was_maximized = !was_fullscreen && window.is_maximized().unwrap_or(false);

    if was_fullscreen {
        window
            .set_fullscreen(false)
            .map_err(|error| error.to_string())?;
    } else if was_maximized {
        window.unmaximize().map_err(|error| error.to_string())?;
    }

    let handle = handle.clone();
    let move_window = move || {
        wait_for_restored_window(&window, was_fullscreen, was_maximized);
        if let Err(error) = apply_window_rect(&window, target_rect) {
            eprintln!("[Monitor] Failed to move main window: {error}");
            return;
        }
        wait_for_target_monitor(&handle, target_index);
        if was_fullscreen {
            if let Err(error) = window.set_fullscreen(true) {
                eprintln!("[Monitor] Failed to restore fullscreen: {error}");
            }
        } else if was_maximized {
            if let Err(error) = window.maximize() {
                eprintln!("[Monitor] Failed to restore maximized state: {error}");
            }
        }
    };

    std::thread::spawn(move_window);

    Ok(())
}

/// Start event-driven window position monitoring.
///
/// This uses Tauri's window move event instead of polling, which is more
/// efficient and responsive. The menu is only rebuilt when the window
/// actually moves to a different monitor.
///
/// # Arguments
/// * `handle` - The app handle
/// * `menu_rebuild_callback` - A callback function to rebuild the menu
pub fn start_position_monitoring<R: Runtime, F>(handle: AppHandle<R>, menu_rebuild_callback: F)
where
    F: Fn(&AppHandle<R>) -> tauri::Result<()> + Send + Sync + Clone + 'static,
{
    // Track last known monitor index to detect actual monitor changes
    let last_monitor_index: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(usize::MAX));

    // Get initial monitor index
    if let Some(idx) = get_current_monitor_index(&handle) {
        last_monitor_index.store(idx, Ordering::Relaxed);
    }

    // Use window move event instead of polling
    if let Some(win) = handle.get_webview_window("main") {
        let handle_clone = handle.clone();
        let callback_clone = menu_rebuild_callback.clone();
        let last_idx = last_monitor_index.clone();

        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Moved(_) = event {
                // Check if monitor actually changed
                if let Some(new_idx) = get_current_monitor_index(&handle_clone) {
                    let prev_idx = last_idx.load(Ordering::Relaxed);
                    if prev_idx != new_idx {
                        eprintln!(
                            "DEBUG MONITOR: Window moved from monitor {} to {}, rebuilding menu",
                            prev_idx, new_idx
                        );
                        last_idx.store(new_idx, Ordering::Relaxed);

                        if let Err(e) = callback_clone(&handle_clone) {
                            eprintln!("DEBUG MONITOR: Failed to rebuild menu: {:?}", e);
                        }
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires a real macOS display session"]
    fn test_get_macos_display_names_not_empty() {
        let names = get_macos_display_names();
        assert!(!names.is_empty(), "macOS display names should not be empty");
    }

    #[test]
    fn native_monitor_bounds_match_the_available_monitor_index() {
        let monitors = [
            Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            Rect {
                x: 1920,
                y: -400,
                width: 1080,
                height: 1920,
            },
        ];
        assert_eq!(monitor_index_from_native(monitors[1], &monitors), Some(1));
        assert_eq!(
            monitor_index_from_native(
                Rect {
                    x: 0,
                    y: 0,
                    width: 1280,
                    height: 720,
                },
                &monitors,
            ),
            None
        );
    }

    #[test]
    fn centered_ninety_percent_window_keeps_its_ratios_on_a_portrait_display() {
        assert_eq!(
            map_window_to_work_area(
                Rect {
                    x: 96,
                    y: 92,
                    width: 1728,
                    height: 936,
                },
                Rect {
                    x: 0,
                    y: 40,
                    width: 1920,
                    height: 1040,
                },
                Rect {
                    x: 1920,
                    y: 24,
                    width: 1080,
                    height: 1896,
                },
            ),
            Rect {
                x: 1974,
                y: 119,
                width: 972,
                height: 1706,
            }
        );
    }

    #[test]
    fn window_edge_anchors_are_preserved_between_different_orientations() {
        assert_eq!(
            map_window_to_work_area(
                Rect {
                    x: 700,
                    y: 550,
                    width: 400,
                    height: 300,
                },
                Rect {
                    x: 100,
                    y: 50,
                    width: 1000,
                    height: 800,
                },
                Rect {
                    x: -1200,
                    y: 0,
                    width: 1200,
                    height: 1920,
                },
            ),
            Rect {
                x: -480,
                y: 1200,
                width: 480,
                height: 720,
            }
        );
    }

    #[test]
    fn oversized_windows_are_clamped_inside_the_target_work_area() {
        assert_eq!(
            map_window_to_work_area(
                Rect {
                    x: -200,
                    y: -100,
                    width: 1400,
                    height: 1000,
                },
                Rect {
                    x: 0,
                    y: 0,
                    width: 1000,
                    height: 800,
                },
                Rect {
                    x: 1000,
                    y: 24,
                    width: 800,
                    height: 1200,
                },
            ),
            Rect {
                x: 1000,
                y: 24,
                width: 800,
                height: 1200,
            }
        );
    }
}
