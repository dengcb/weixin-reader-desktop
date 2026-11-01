//! 遥控器音量键的系统音量抑制（macOS）。
//!
//! 遥控器把音量 ± 声明在键盘页（usage 0x80/0x81），macOS 会同时生成
//! NX_SYSDEFINED 系统音量事件。本模块在遥控器音量键按住期间，用会话级
//! CGEventTap 吞掉所有 NX_SYSDEFINED（键码/时序在系统事件里不可靠，直接整类
//! 吞掉；窗口仅限按住期间），松开立即恢复，物理键盘音量键日常不受影响。
//! 30 秒兜底有效期防止 release 丢失后持续误吞。
//!
//! 约束（见 docs/BLUETOOTH_REMOTE_EXPLORATION.md 二期）：
//! - 修改事件需要「辅助功能」权限；未授权时只记录日志，不阻断功能。
//! - tap 跑在专用线程的 RunLoop 上，避免主线程卡顿拖慢全系统输入。
//! - 超时/被系统禁用后立即重新启用；进程退出由系统回收。

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, AtomicU8, Ordering};
use std::sync::OnceLock;

const NX_SYSDEFINED: u32 = 14;
/// kCGSessionEventTap
const K_CG_SESSION_EVENT_TAP: u32 = 1;
/// kCGHeadInsertEventTap
const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
/// kCGEventTapOptionDefault（可修改/吞掉事件）
const K_CG_EVENT_TAP_OPTION_DEFAULT: u32 = 0;
/// 事件 tap 被系统禁用时回调收到的伪事件类型。
const K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;

const HELD_UP: u8 = 0b01;
const HELD_DOWN: u8 = 0b10;
/// 按住状态的安全有效期：防止丢失 release 后误吞其他媒体键。
const HOLD_SAFETY_MS: u64 = 30_000;

type CGEventRef = *mut c_void;
type CGEventTapProxy = *mut c_void;
type CFMachPortRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type CFRunLoopRef = *mut c_void;
type CFStringRef = *const c_void;
type CGEventTapCallBack =
    unsafe extern "C" fn(CGEventTapProxy, u32, CGEventRef, *mut c_void) -> CGEventRef;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: Option<CGEventTapCallBack>,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
}

// CFDictionaryCreate 在 remote_hid 中已用具体回调结构体声明；这里是同符号的
// 指针签名（ABI 一致），显式允许该重复声明告警。
#[allow(clashing_extern_declarations)]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: CFStringRef;
    static kCFBooleanTrue: *const c_void;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    fn CFMachPortCreateRunLoopSource(
        allocator: *const c_void,
        port: CFMachPortRef,
        order: isize,
    ) -> CFRunLoopSourceRef;
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFRunLoopAddSource(run_loop: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    fn CFRunLoopRun();
    #[link_name = "CFDictionaryCreate"]
    fn cf_dictionary_create(
        allocator: *const c_void,
        keys: *const *const c_void,
        values: *const *const c_void,
        num_values: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> *const c_void;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    static kAXTrustedCheckOptionPrompt: CFStringRef;
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
}

/// 当前按住的遥控器音量键位（HELD_UP / HELD_DOWN）。
static HELD: AtomicU8 = AtomicU8::new(0);
static SUPPRESS_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
static STARTED: AtomicBool = AtomicBool::new(false);
static WARNED: AtomicBool = AtomicBool::new(false);
static STARTED_AT: OnceLock<std::time::Instant> = OnceLock::new();

fn now_ms() -> u64 {
    STARTED_AT
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}
static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

/// 由 HID 层在每次报文解析后调用：up/down 表示遥控器当前的音量键状态。
/// 首次出现按住状态时惰性启动 tap（可能触发辅助功能授权提示）。
pub fn set_volume_keys(up: bool, down: bool) {
    let mut bits = 0u8;
    if up {
        bits |= HELD_UP;
    }
    if down {
        bits |= HELD_DOWN;
    }
    let previous = HELD.swap(bits, Ordering::SeqCst);
    if bits != 0 {
        SUPPRESS_UNTIL_MS.store(now_ms() + HOLD_SAFETY_MS, Ordering::SeqCst);
        if previous == 0 {
            ensure_started();
        }
    }
}

/// 启动抑制器（幂等）。未授权时不创建 tap，只记录一次日志。
pub fn ensure_started() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let trusted = unsafe {
        // 已未授权时弹出系统授权窗；用户点允许后按下一次音量键即生效。
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let options = cf_dictionary_create(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        );
        AXIsProcessTrustedWithOptions(options)
    };
    if trusted {
        spawn_tap_thread();
        return;
    }
    // 未授权：只提示一次；下次按键会重试（用户可能在系统设置里刚授权）。
    if !WARNED.swap(true, Ordering::SeqCst) {
        log::warn!(
            target: "remote-hid",
            "音量键抑制需要「辅助功能」权限；请在系统设置中允许后按一下遥控器音量键（当前仍会调整系统音量）"
        );
    }
    STARTED.store(false, Ordering::SeqCst);
}

/// 已授权时预先启动 tap（遥控器连接时调用）：避免首次按键因 tap 尚未
/// 建立而漏掉系统音量事件。
pub fn ensure_started_if_trusted() {
    if unsafe { AXIsProcessTrusted() } {
        ensure_started();
    }
}

fn spawn_tap_thread() {
    let spawn = std::thread::Builder::new()
        .name("media-key-suppressor".into())
        .spawn(|| unsafe {
            let mask: u64 = 1 << NX_SYSDEFINED;
            let tap = CGEventTapCreate(
                K_CG_SESSION_EVENT_TAP,
                K_CG_HEAD_INSERT_EVENT_TAP,
                K_CG_EVENT_TAP_OPTION_DEFAULT,
                mask,
                Some(tap_callback),
                std::ptr::null_mut(),
            );
            if tap.is_null() {
                log::warn!(
                    target: "remote-hid",
                    "音量键抑制启动失败（辅助功能权限未生效），系统音量仍会变化"
                );
                return;
            }
            TAP_PORT.store(tap, Ordering::SeqCst);
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            let run_loop = CFRunLoopGetCurrent();
            CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
            CGEventTapEnable(tap, true);
            log::info!(target: "remote-hid", "音量键抑制已启动（按住遥控器音量键时不改系统音量）");
            CFRunLoopRun();
        });
    if spawn.is_err() {
        log::warn!(target: "remote-hid", "音量键抑制线程创建失败");
        STARTED.store(false, Ordering::SeqCst);
    }
}

unsafe extern "C" fn tap_callback(
    _proxy: CGEventTapProxy,
    event_type: u32,
    event: CGEventRef,
    _user_info: *mut c_void,
) -> CGEventRef {
    if event_type == K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT
        || event_type == K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT
    {
        let tap = TAP_PORT.load(Ordering::SeqCst);
        if !tap.is_null() {
            CGEventTapEnable(tap, true);
        }
        return event;
    }
    if event_type != NX_SYSDEFINED {
        return event;
    }
    let held = HELD.load(Ordering::SeqCst);
    if held == 0 || now_ms() >= SUPPRESS_UNTIL_MS.load(Ordering::SeqCst) {
        return event;
    }
    // 遥控器音量键按住期间，系统媒体事件必然来自它；直接吞掉所有
    // NX_SYSDEFINED，避免上下键码/时序差异导致漏吞。
    std::ptr::null_mut()
}
