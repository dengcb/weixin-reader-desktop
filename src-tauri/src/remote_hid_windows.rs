//! Windows Raw Input 识别层（零提权）。
//!
//! 机制参照 remote-mic-app-windows（SayAll Windows 版，GPL-3.0，只学机制
//! 不抄代码）的真机结论（其 docs/investigations/2026-09-23 系列调查）：
//!
//! - RC003 固件把返回 0xF1 / 音量± 0x80/0x81 声明在键盘页 report 1（与可用的
//!   OK/Home 同一报告），但 Windows `kbdhid` 驱动的 HID→VK 映射表缺这三个
//!   usage，在键码翻译阶段丢弃，系统层面零事件。无提权路径已被穷尽实测否决
//!   （厂商 GATT 通知静默、GATT HID 特征 AccessDenied、用户态直读 HID 顶层
//!   集合被 Raw Input Manager 独占拒绝）——音量±/返回在 Windows 不可得，
//!   维持文档边界，不做提权注入。
//! - Raw Input 键盘通道能拿到的增补键：TV（VK_OEM_3）、语音（F5）、媒体
//!   音量键（VK_VOLUME_UP/DOWN），以及 RC001 系老固件的厂商键族
//!   （VK 0xFF + 扫描码：返回/音量±/电源，物理键盘不会产生）。
//! - 原生副作用边界：电源键在 RC003 上映射为 VK_SLEEP，原生触发系统睡眠，
//!   刻意不接入；F5 的刷新副作用在未接入时同样存在，接入不加重伤害；
//!   方向/OK/Home/菜单沿用 WebView 键盘路径（只增不改），本层不重复发。
//!
//! 与 macOS `remote_hid.rs` 共用 `remote-hid-button` 事件契约
//! `{ button, phase, usage }`，前端 `remote_hid_source.ts` 无需感知平台。

#[cfg_attr(not(target_os = "windows"), allow(unused_imports))]
use tauri::{AppHandle, Wry};

/// 主窗口消费的事件名，与 macOS remote_hid.rs 对齐。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const BUTTON_EVENT: &str = "remote-hid-button";
/// 日志 target 与 macOS 侧一致，便于统一检索。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const TARGET: &str = "remote-hid";
/// 小米遥控器 USB 标识（设备路径中的形态为 VID_2717&PID_32B8）。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const XIAOMI_VENDOR_ID_HEX: &str = "VID_2717";
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const XIAOMI_PRODUCT_ID_HEX: &str = "PID_32B8";

// ---- 纯逻辑：VK → 按键与边沿状态（跨平台可单测） ----

/// RAWKEYBOARD 的 VK/扫描码 → 稳定按键名。
///
/// 只返回值得增补的键：系统键盘路径已处理的（方向/OK/Home/菜单）与原生
/// 副作用不可接受的（VK_SLEEP 睡眠、静音无动作）都返回 None。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn button_for_keyboard(virtual_key: u16, make_code: u16) -> Option<&'static str> {
    // RC001 系固件的厂商键族：VK 0xFF 携带真实键义在扫描码里，物理键盘
    // 不会产生 0xFF，零原生副作用。
    if virtual_key == 0xFF {
        return match make_code {
            0x5E => Some("power"),
            0x6A => Some("back"),
            0x30 => Some("volume_up"),
            0x2E => Some("volume_down"),
            _ => None,
        };
    }
    match virtual_key {
        0xC0 => Some("tv"),          // VK_OEM_3（` 键）
        0x74 => Some("voice"),       // F5（语音键）
        0xAF => Some("volume_up"),   // VK_VOLUME_UP 媒体键
        0xAE => Some("volume_down"), // VK_VOLUME_DOWN 媒体键
        // 0x25-0x28 方向 / 0x0D OK / 0x24 Home / 0x5D 菜单：键盘路径已处理；
        // 0x5F VK_SLEEP：原生触发系统睡眠，不接入；0xAD 静音：无绑定动作。
        _ => None,
    }
}

/// 按键边沿状态机：自动重复的连续 keyDown 只出一次按下，松开出一次松开。
/// 返回本次应广播的相位。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn edge_phase(
    active: &mut std::collections::HashMap<&'static str, bool>,
    button: &'static str,
    is_release: bool,
) -> Option<&'static str> {
    let was = *active.get(button).unwrap_or(&false);
    let now = !is_release;
    if was == now {
        return None;
    }
    active.insert(button, now);
    Some(if is_release { "release" } else { "press" })
}

// ---- Win32 实现 ----

#[cfg(target_os = "windows")]
mod win {
    use super::{button_for_keyboard, edge_phase, BUTTON_EVENT, TARGET,
        XIAOMI_PRODUCT_ID_HEX, XIAOMI_VENDOR_ID_HEX};
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use tauri::{AppHandle, Emitter, Manager, Wry};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::{
        GetRawInputData, GetRawInputDeviceInfoW, RegisterRawInputDevices, HRAWINPUT,
        RAWINPUT, RAWINPUTDEVICE, RIDEV_DEVNOTIFY, RIDEV_INPUTSINK, RIDI_DEVICENAME,
        RID_INPUT, RIM_TYPEKEYBOARD,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage,
        RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE,
        WM_DESTROY, WM_INPUT, WM_INPUT_DEVICE_CHANGE, WNDCLASSW,
    };

    /// WM_INPUT_DEVICE_CHANGE 的 wParam（windows crate 未导出）。
    const GIDC_ARRIVAL: usize = 1;
    const GIDC_REMOVAL: usize = 2;
    /// RAWKEYBOARD.Flags 的断开位（windows crate 未导出，Win32 文档值）。
    const RI_KEY_BREAK: u16 = 0x0001;

    struct WinContext {
        app: AppHandle<Wry>,
        /// hDevice → 是否目标遥控器（设备路径查询结果缓存）。
        attribution: Mutex<HashMap<isize, bool>>,
        /// 按键边沿状态（自动重复去重）。
        active: Mutex<HashMap<&'static str, bool>>,
    }

    static STARTED: AtomicBool = AtomicBool::new(false);
    static CONTEXT: OnceLock<Box<WinContext>> = OnceLock::new();

    /// 启动监听（幂等）：专用线程承载 message-only 窗口与消息泵。
    pub fn start(app: &AppHandle<Wry>) {
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = CONTEXT.set(Box::new(WinContext {
            app: app.clone(),
            attribution: Mutex::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
        }));
        let app_for_log = app.clone();
        thread::Builder::new()
            .name("remote-hid-raw-input".into())
            .spawn(move || {
                if let Err(error) = run_message_loop() {
                    log::warn!(target: TARGET, "Raw Input 监听启动失败：{error}");
                } else {
                    log::info!(target: TARGET, "Raw Input 监听已停止");
                }
                let _ = app_for_log;
            })
            .ok();
    }

    fn run_message_loop() -> Result<(), String> {
        unsafe {
            let module = GetModuleHandleW(None).map_err(|e| e.to_string())?;
            let instance = HINSTANCE(module.0);
            let class_name: PCWSTR = w!("AtReaderRemoteHidSink");
            let class = WNDCLASSW {
                lpfnWndProc: Some(wnd_proc),
                hInstance: instance,
                lpszClassName: class_name,
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                return Err("RegisterClassW 失败".to_string());
            }
            // message-only 窗口：不参与可见 UI，仅接收投递到线程的消息。
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                w!("AtReaderRemoteHidSink"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(instance),
                None,
            )
            .map_err(|e| format!("CreateWindowExW 失败：{e}"))?;
            let devices = [
                // 键盘 TLC：RIDEV_INPUTSINK 允许无焦点接收，DEVNOTIFY 拿插拔事件。
                RAWINPUTDEVICE {
                    usUsagePage: 0x01,
                    usUsage: 0x06,
                    dwFlags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
                    hwndTarget: hwnd,
                },
            ];
            RegisterRawInputDevices(
                &devices,
                std::mem::size_of::<RAWINPUTDEVICE>() as u32,
            )
            .map_err(|e| format!("RegisterRawInputDevices 失败：{e}"))?;
            log::info!(target: TARGET, "Raw Input 监听已打开（键盘通道）");

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            Ok(())
        }
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_INPUT => {
                handle_raw_input(l_param);
                DefWindowProcW(hwnd, msg, w_param, l_param)
            }
            WM_INPUT_DEVICE_CHANGE => {
                // 设备插拔：清除归属缓存；移除时复位边沿状态防粘键。
                if w_param.0 == GIDC_ARRIVAL || w_param.0 == GIDC_REMOVAL {
                    if let Some(ctx) = CONTEXT.get() {
                        if let Ok(mut attribution) = ctx.attribution.lock() {
                            attribution.clear();
                        }
                        if w_param.0 == GIDC_REMOVAL {
                            if let Ok(mut active) = ctx.active.lock() {
                                active.clear();
                            }
                            log::info!(target: TARGET, "输入设备已移除，状态已复位");
                        }
                    }
                }
                DefWindowProcW(hwnd, msg, w_param, l_param)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, w_param, l_param),
        }
    }

    unsafe fn handle_raw_input(l_param: LPARAM) {
        let raw_handle = HRAWINPUT(l_param.0 as *mut core::ffi::c_void);
        let mut size: u32 = 0;
        if GetRawInputData(raw_handle, RID_INPUT, None, &mut size,
            std::mem::size_of::<RAWINPUT>() as u32) == u32::MAX
        {
            return;
        }
        let mut buffer = vec![0u8; size as usize];
        let copied = GetRawInputData(
            raw_handle,
            RID_INPUT,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut size,
            std::mem::size_of::<RAWINPUT>() as u32,
        );
        if copied == u32::MAX || buffer.len() < std::mem::size_of::<RAWINPUT>() {
            return;
        }
        let raw = &*(buffer.as_ptr() as *const RAWINPUT);
        if raw.header.dwType != RIM_TYPEKEYBOARD.0 {
            return;
        }
        let keyboard = raw.data.keyboard;
        let device = raw.header.hDevice;
        // hDevice 为空的键盘事件来自系统注入/遗留路径，不归因到遥控器。
        if device.0.is_null() {
            return;
        }
        let Some(ctx) = CONTEXT.get() else { return };
        if !device_is_remote(&ctx, device) {
            return;
        }
        let Some(button) = button_for_keyboard(keyboard.VKey, keyboard.MakeCode) else {
            return;
        };
        let is_release = keyboard.Flags & RI_KEY_BREAK != 0;
        let Ok(mut active) = ctx.active.lock() else { return };
        let Some(phase) = edge_phase(&mut active, button, is_release) else { return };
        drop(active);
        log::info!(target: TARGET, "按键 {button} {phase}");
        if let Some(win) = ctx.app.get_webview_window("main") {
            let _ = win.emit(
                BUTTON_EVENT,
                json!({ "button": button, "phase": phase, "usage": 0 }),
            );
        }
    }

    /// 设备归属：hDevice → 设备路径是否含小米遥控器 VID/PID（结果缓存）。
    unsafe fn device_is_remote(ctx: &WinContext, device: HANDLE) -> bool {
        let key = device.0 as isize;
        if let Ok(attribution) = ctx.attribution.lock() {
            if let Some(known) = attribution.get(&key) {
                return *known;
            }
        }
        let mut size: u32 = 0;
        let _ = GetRawInputDeviceInfoW(Some(device), RIDI_DEVICENAME, None, &mut size);
        let is_remote = if size == 0 {
            false
        } else {
            let mut path = vec![0u16; size as usize];
            let ok = GetRawInputDeviceInfoW(
                Some(device),
                RIDI_DEVICENAME,
                Some(path.as_mut_ptr() as *mut _),
                &mut size,
            );
            if ok == u32::MAX {
                false
            } else {
                let text = String::from_utf16_lossy(&path).to_uppercase();
                text.contains(XIAOMI_VENDOR_ID_HEX) && text.contains(XIAOMI_PRODUCT_ID_HEX)
            }
        };
        if let Ok(mut attribution) = ctx.attribution.lock() {
            attribution.insert(key, is_remote);
        }
        is_remote
    }
}

#[cfg(target_os = "windows")]
pub fn start(app: &AppHandle<Wry>) {
    win::start(app);
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub fn start(_app: &AppHandle<Wry>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_supplementary_keys_only() {
        // 增补键
        assert_eq!(button_for_keyboard(0xC0, 0), Some("tv"));
        assert_eq!(button_for_keyboard(0x74, 0), Some("voice"));
        assert_eq!(button_for_keyboard(0xAF, 0), Some("volume_up"));
        assert_eq!(button_for_keyboard(0xAE, 0), Some("volume_down"));
        // RC001 厂商键族（扫描码承载键义）
        assert_eq!(button_for_keyboard(0xFF, 0x6A), Some("back"));
        assert_eq!(button_for_keyboard(0xFF, 0x30), Some("volume_up"));
        assert_eq!(button_for_keyboard(0xFF, 0x2E), Some("volume_down"));
        assert_eq!(button_for_keyboard(0xFF, 0x5E), Some("power"));
        // 系统键盘路径已处理的键不重复发
        for vk in [0x25, 0x26, 0x27, 0x28, 0x0D, 0x24, 0x5D] {
            assert_eq!(button_for_keyboard(vk, 0), None);
        }
        // VK_SLEEP 原生睡眠副作用，不接入；未知 0xFF 扫描码不猜
        assert_eq!(button_for_keyboard(0x5F, 0), None);
        assert_eq!(button_for_keyboard(0xFF, 0x99), None);
    }

    #[test]
    fn edge_phase_deduplicates_autorepeat() {
        let mut active = std::collections::HashMap::new();
        assert_eq!(edge_phase(&mut active, "tv", false), Some("press"));
        // 自动重复的后续 keyDown 不再出沿
        assert_eq!(edge_phase(&mut active, "tv", false), None);
        assert_eq!(edge_phase(&mut active, "tv", true), Some("release"));
        // 无按下的松开（漏沿）不出事件
        assert_eq!(edge_phase(&mut active, "tv", true), None);
        assert_eq!(edge_phase(&mut active, "tv", false), Some("press"));
    }
}
