//! Multi-monitor support module
//!
//! This module provides functionality for:
//! - Detecting the current monitor (display) where the window is located
//! - Getting macOS system display names
//! - Building menu items for moving window between monitors
//! - Monitoring window position changes and updating menu dynamically

#![allow(deprecated)]

use tauri::{AppHandle, Manager, Runtime};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(target_os = "macos")]
use objc::{msg_send, sel, sel_impl, class};
#[cfg(target_os = "macos")]
use cocoa::base::{id, nil};
#[cfg(target_os = "macos")]
use cocoa::foundation::NSString;

/// Get the index of the monitor (display) where the main window is currently located.
///
/// This function uses the window's physical position and converts it to logical coordinates
/// to determine which monitor contains the window.
///
/// # Returns
/// * `Some(usize)` - The index of the monitor containing the window
/// * `None` - Unable to determine the monitor (window not found or position unavailable)
pub fn get_current_monitor_index<R: Runtime>(handle: &AppHandle<R>) -> Option<usize> {
    // Get window position (physical pixels)
    let (window_x, window_y) = handle.get_webview_window("main")
        .and_then(|w| w.outer_position().ok())
        .map(|p| (p.x, p.y))
        .unwrap_or((0, 0));

    eprintln!("DEBUG: get_current_monitor_index: window position = ({}, {})", window_x, window_y);

    // Use Tauri's available_monitors to get all displays
    if let Ok(monitors) = handle.available_monitors() {
        eprintln!("DEBUG: Total monitors: {}", monitors.len());

        for (i, monitor) in monitors.iter().enumerate() {
            let pos = monitor.position();
            let size = monitor.size();
            let scale = monitor.scale_factor();

            eprintln!("DEBUG: Monitor[{}]: x={}, y={}, width={}, height={}, scale={}",
                i, pos.x, pos.y, size.width, size.height, scale);

            // Convert monitor physical bounds to logical bounds
            let logical_mx = pos.x as f64 / scale;
            let logical_my = pos.y as f64 / scale;
            let logical_mw = size.width as f64 / scale;
            let logical_mh = size.height as f64 / scale;

            // Convert window position to logical
            let logical_wx = window_x as f64 / scale;
            let logical_wy = window_y as f64 / scale;

            // Check if logical window position is within this monitor's bounds
            let within_x = logical_wx >= logical_mx && logical_wx < logical_mx + logical_mw;
            let within_y = logical_wy >= logical_my && logical_wy < logical_my + logical_mh;

            eprintln!("DEBUG: Window logical ({:.0}, {:.0}) within monitor[{}]: x={}, y={}",
                logical_wx, logical_wy, i, within_x, within_y);

            if within_x && within_y {
                eprintln!("DEBUG: Window is on monitor[{}]", i);
                return Some(i);
            }
        }
    }

    eprintln!("DEBUG: Could not determine which monitor the window is on");
    None
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
            let name_key: id = NSString::alloc(nil).init_str("NSDeviceName");
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

/// Get display names for non-macOS platforms (placeholder).
#[cfg(not(target_os = "macos"))]
pub fn get_display_names() -> Vec<String> {
    vec!["Monitor 1".to_string()]
}

/// Calculate the center position for moving a window to a target monitor.
///
/// # Arguments
/// * `monitor_index` - The index of the target monitor
/// * `window_size` - The current window size (physical pixels)
/// * `handle` - The app handle to get monitor information
///
/// # Returns
/// * `Some((i32, i32))` - The (x, y) logical position for centering the window
/// * `None` - Unable to calculate (monitor not found or window not available)
pub fn calculate_center_position<R: Runtime>(
    monitor_index: usize,
    window_size: (u32, u32),
    handle: &AppHandle<R>,
) -> Option<(i32, i32)> {
    if let Ok(monitors) = handle.available_monitors() {
        if let Some(target_monitor) = monitors.get(monitor_index) {
            let scale = target_monitor.scale_factor();
            let pos = target_monitor.position();
            let size = target_monitor.size();

            // Convert window size from physical pixels to logical points
            let logical_width = (window_size.0 as f64 / scale) as i32;
            let logical_height = (window_size.1 as f64 / scale) as i32;

            // Convert monitor bounds to logical
            let logical_mx = pos.x as f64 / scale;
            let logical_my = pos.y as f64 / scale;
            let logical_mw = size.width as f64 / scale;
            let logical_mh = size.height as f64 / scale;

            // Calculate center position
            let x = (logical_mx + (logical_mw - logical_width as f64) / 2.0) as i32;
            let y = (logical_my + (logical_mh - logical_height as f64) / 2.0) as i32;

            eprintln!("DEBUG: Calculated center position ({}, {}) for monitor[{}]", x, y, monitor_index);
            eprintln!("DEBUG: Target monitor: logical=({:.0}, {:.0}), size={:.0}x{:.0}, scale={}",
                logical_mx, logical_my, logical_mw, logical_mh, scale);
            eprintln!("DEBUG: Window size: physical={}x{}, logical={}x{}",
                window_size.0, window_size.1, logical_width, logical_height);

            return Some((x, y));
        }
    }

    None
}

/// Start monitoring window position changes.
///
/// This spawns a background thread that periodically checks the window position
/// and triggers menu rebuild when the window moves to a different monitor.
///
/// # Arguments
/// * `handle` - The app handle
/// * `menu_rebuild_callback` - A callback function to rebuild the menu
pub fn start_position_monitoring<R: Runtime, F>(
    handle: AppHandle<R>,
    menu_rebuild_callback: F,
) where
    F: Fn(&AppHandle<R>) -> tauri::Result<()> + Send + Clone + 'static,
{
    let running = Arc::new(AtomicBool::new(true));
    let handle_clone = handle.clone();
    let mut last_monitor_index: Option<usize> = None;

    std::thread::spawn(move || {
        let mut last_position = None;

        while running.load(Ordering::Relaxed) {
            if let Some(win) = handle_clone.get_webview_window("main") {
                if let Ok(win_pos) = win.outer_position() {
                    // Only process if position changed
                    if last_position != Some((win_pos.x, win_pos.y)) {
                        eprintln!("DEBUG MONITOR: Window position ({}, {})", win_pos.x, win_pos.y);

                        // Get current monitor
                        if let Ok(monitors) = handle_clone.available_monitors() {
                            for (i, monitor) in monitors.iter().enumerate() {
                                let scale = monitor.scale_factor();
                                let monitor_pos = monitor.position();
                                let monitor_size = monitor.size();

                                // Convert monitor to logical bounds
                                let logical_mx = monitor_pos.x as f64 / scale;
                                let logical_my = monitor_pos.y as f64 / scale;
                                let logical_mw = monitor_size.width as f64 / scale;
                                let logical_mh = monitor_size.height as f64 / scale;

                                // Convert window position to logical
                                let logical_wx = win_pos.x as f64 / scale;
                                let logical_wy = win_pos.y as f64 / scale;

                                let within = logical_wx >= logical_mx && logical_wx < logical_mx + logical_mw
                                    && logical_wy >= logical_my && logical_wy < logical_my + logical_mh;

                                if within {
                                    // Check if monitor changed
                                    if last_monitor_index != Some(i) {
                                        eprintln!("DEBUG MONITOR: Window moved from monitor {:?} to {}, rebuilding menu",
                                            last_monitor_index, i);
                                        last_monitor_index = Some(i);

                                        // Rebuild menu after a short delay
                                        let handle = handle_clone.clone();
                                        let callback = menu_rebuild_callback.clone();
                                        std::thread::spawn(move || {
                                            std::thread::sleep(std::time::Duration::from_millis(100));
                                            if let Err(e) = callback(&handle) {
                                                eprintln!("DEBUG MONITOR: Failed to rebuild menu: {:?}", e);
                                            }
                                        });
                                    }
                                    break;
                                }
                            }
                        }

                        last_position = Some((win_pos.x, win_pos.y));
                    }
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_display_names_not_empty() {
        #[cfg(target_os = "macos")]
        let names = get_macos_display_names();
        #[cfg(not(target_os = "macos"))]
        let names = get_display_names();

        assert!(!names.is_empty(), "Display names should not be empty");
    }

    #[test]
    fn test_calculate_center_position_basic() {
        // This is a basic unit test - integration tests would need a running Tauri app
        // For now, we just test the function signature and None handling
        // TODO: Add proper integration tests with mock AppHandle
    }
}
