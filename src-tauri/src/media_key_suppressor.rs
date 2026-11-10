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
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicPtr, AtomicU64, AtomicU8, Ordering};
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
/// 竞速窗口（2026-11-09 实证）：系统 NX_SYSDEFINED 常先于 HID 报文 0~6ms
/// 到达（极端卡顿 148~224ms），HELD 就绪前对未裁决的媒体事件最多等这么久。
const NX_HELD_WAIT_MS: u64 = 30;

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
/// 抑制窗口超时兜底是否已告警过（窗口重置时清零，防重复刷屏）。
static EXPIRY_WARNED: AtomicBool = AtomicBool::new(false);
/// 当前在位的遥控器 HID 设备节点数（match +1 / remove -1）：仅遥控器连接
/// 期间才启用 NX 等待窗口，断开后物理键盘媒体键零额外延迟。
static REMOTE_NODES: AtomicIsize = AtomicIsize::new(0);

/// remote_hid 的设备匹配回调上报：同一遥控器有多个 HID 节点，按计数管理。
pub fn remote_device_matched() {
    REMOTE_NODES.fetch_add(1, Ordering::SeqCst);
}

/// remote_hid 的设备移除回调上报。若与匹配不完全配对导致负数，
/// `> 0` 判定自动退化为「不等待」，行为回到竞速基线，无副作用。
pub fn remote_device_removed() {
    REMOTE_NODES.fetch_sub(1, Ordering::SeqCst);
}
static STARTED: AtomicBool = AtomicBool::new(false);
static WARNED: AtomicBool = AtomicBool::new(false);
/// 授权提示只在首次请求；之后静默检测，避免未授权时每按一次音量键
/// 都把系统设置面板拉起来。
static PROMPTED: AtomicBool = AtomicBool::new(false);
static STARTED_AT: OnceLock<std::time::Instant> = OnceLock::new();

fn now_ms() -> u64 {
    STARTED_AT
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}
static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
/// 禁 App Nap 的活动断言（NSProcessInfoActivity，返回值自带所有权，
/// 存静态保持至进程退出，刻意不释放）。
static NO_NAP_ACTIVITY: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

/// App Nap 会冻结本进程全部线程：后台启动且从未激活过的 app 被系统 nap
/// 后，抑制 tap 与 HID 回调线程全部停摆，音量键在后台完全失控（2026-11-09
/// 真机复现：后台启动 → 按键直出系统音量；回前台首键还需等 tap 超时重启用，
/// 之后才恢复接管）。tap 建立即持有 UserInitiatedAllowingIdleSystemSleep
/// 活动断言：只禁 App Nap，不阻止系统空闲睡眠。
unsafe fn begin_no_nap_activity() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let process_info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
    if process_info.is_null() {
        return;
    }
    let reason = std::ffi::CString::new("remote volume suppression: keep event tap responsive")
        .expect("reason 不含 NUL");
    let reason_ns: *mut AnyObject = msg_send![
        class!(NSString),
        stringWithUTF8String: reason.as_ptr()
    ];
    // NSActivityUserInitiatedAllowingIdleSystemSleep = 0x00FFFFFF。
    let activity: *mut AnyObject = msg_send![
        process_info,
        beginActivityWithOptions: 0x00FF_FFFFu64,
        reason: reason_ns
    ];
    if !activity.is_null() {
        NO_NAP_ACTIVITY.store(activity.cast(), Ordering::SeqCst);
        log::info!(target: "remote-hid", "已持有禁用 App Nap 断言（保持遥控事件响应）");
    }
}

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
        EXPIRY_WARNED.store(false, Ordering::SeqCst);
        if previous == 0 {
            ensure_started();
        }
    } else if previous != 0 {
        EXPIRY_WARNED.store(false, Ordering::SeqCst);
    }
}

/// 启动抑制器（幂等）。未授权时不创建 tap，只记录一次日志。
pub fn ensure_started() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let trusted = unsafe {
        if PROMPTED.swap(true, Ordering::SeqCst) {
            // 之后只做静默检测：用户授权后下一次按键即可启动 tap。
            AXIsProcessTrusted()
        } else {
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
        }
    };
    if trusted {
        spawn_tap_thread();
        return;
    }
    // 未授权：日志只提示一次；下次按键静默重试（用户可能在系统设置里刚授权）。
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
            begin_no_nap_activity();
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
        let kind = if event_type == K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT {
            "超时"
        } else {
            "用户输入"
        };
        log::warn!(target: "remote-hid", "音量抑制 tap 被系统禁用（{kind}），已重新启用");
        let tap = TAP_PORT.load(Ordering::SeqCst);
        if !tap.is_null() {
            CGEventTapEnable(tap, true);
        }
        return event;
    }
    if event_type != NX_SYSDEFINED {
        return event;
    }
    let mut held = HELD.load(Ordering::SeqCst);
    // 竞速裁决：遥控器连接期间，HELD 未就绪的事件可能是 HID 报文尚在途中
    // （系统路径先天快几毫秒）。最多等 NX_HELD_WAIT_MS 让 HELD 追上——追上
    // 即吞（遥控器音量）；等满仍无报文则放行（物理键盘媒体键照常工作，
    // 仅多 ≤30ms 无感延迟；NX 类事件非延迟敏感）。本回调只拦 NX_SYSDEFINED，
    // 等待不会阻塞其他输入事件。
    if held == 0 && REMOTE_NODES.load(Ordering::SeqCst) > 0 {
        let deadline = now_ms() + NX_HELD_WAIT_MS;
        while held == 0 && now_ms() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(1));
            held = HELD.load(Ordering::SeqCst);
        }
    }
    if held != 0 && now_ms() < SUPPRESS_UNTIL_MS.load(Ordering::SeqCst) {
        // 遥控器音量键按住期间，系统媒体事件必然来自它；直接吞掉所有
        // NX_SYSDEFINED，避免上下键码/时序差异导致漏吞。
        return std::ptr::null_mut();
    }
    if held != 0 && !EXPIRY_WARNED.swap(true, Ordering::SeqCst) {
        log::warn!(
            target: "remote-hid",
            "音量抑制窗口超时兜底触发（音量键 release 疑似丢失，期间系统音量事件已放行）"
        );
    }
    event
}
