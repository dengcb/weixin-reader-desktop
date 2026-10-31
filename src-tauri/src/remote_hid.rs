//! 蓝牙遥控器 HID 识别层（macOS）。
//!
//! 目标（第一性原理拆解）：把小米蓝牙语音遥控器（VID 0x2717 / PID 0x32B8）
//! 的全部按键识别成事件，其余处理交给既有链路。
//!
//! 为什么必须直读原始报文：macOS 的 HID 事件系统只映射该遥控器的一部分
//! usage——方向/OK/Home/菜单成为键盘事件，音量键成为系统音量事件；而
//! 返回键（键盘页 0xF1，保留区）、音量键（键盘页 0x80/0x81，不是 Consumer
//! 页 0xE9/0xEA）与语音键（0x3E，即 F5）不进入任何应用层，WebView 收到的
//! 永远是 null（见 docs/BLUETOOTH_REMOTE_EXPLORATION.md）。本模块绕过事件
//! 系统，直接订阅 IOHIDManager 的原始输入报文（需要「输入监控」TCC 权限），
//! 对 report ID 1 解析出 usage 集合，与上次状态 diff 出按下/松开边沿，
//! 广播 `remote-hid-button` 事件给主窗口。
//!
//! 机制参照 remote-mic（SayAll，GPL-3.0）公开实现的思路，代码为独立实现。
//!
//! 安全边界：
//! - 键盘页节点只监听（kIOHIDOptionsTypeNone），不夺取：方向键等既有系统
//!   体验不受影响。同一按键可能同时产生原生键盘事件与本模块事件，由消费
//!   方按 `button` 名取舍。
//! - 消费者页节点在监听打开被拒时尝试夺取兜底：macOS 不映射该节点的报文
//!   （音量/返回键系统层无事件），夺取不改变任何既有行为。
//! - 匹配字典固定 VID/PID，不会触碰其他 HID 设备。
//! - 报文回调跑在主 RunLoop，只做解析与事件广播，不做阻塞工作。
//! - 监听器与应用同生命周期，进程退出由系统回收，无单独关闭路径。

use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::os::raw::{c_char, c_void};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Wry};

/// 主窗口消费的事件名：`listen("remote-hid-button")`。
pub const BUTTON_EVENT: &str = "remote-hid-button";
/// 日志 target，日志检索键。
const TARGET: &str = "remote-hid";

/// 小米蓝牙语音遥控器（小米蓝牙遥控器 2 系列）USB Vendor ID。
const XIAOMI_VENDOR_ID: i32 = 0x2717;
/// 小米蓝牙语音遥控器 USB Product ID。
const XIAOMI_PRODUCT_ID: i32 = 0x32B8;

/// 授权等待重试：用户在系统设置点允许是异步的，最多等 30 秒。
const OPEN_RETRY_ATTEMPTS: u32 = 6;
const OPEN_RETRY_INTERVAL: Duration = Duration::from_secs(5);
/// 节点级打开重试：启动时 TCC 授权窗口期的失败是瞬时的，和弦报文所在
/// 的厂商节点只有被打开后才会投递报文，必须重试到成功。
const NODE_OPEN_MAX_ATTEMPTS: u32 = 12;
const NODE_OPEN_RETRY_INTERVAL: Duration = Duration::from_secs(5);

// ---- IOKit HID / CoreFoundation FFI（仅绑定用到的最小面） ----

type CFAllocatorRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFIndex = isize;
type CFNumberRef = *const c_void;
type CFRunLoopRef = *const c_void;
type CFStringRef = *const c_void;
type IOHIDDeviceRef = *mut c_void;
type IOHIDManagerRef = *mut c_void;
/// IOReturn / IOHIDAccessType / IOHIDRequestType / IOHIDReportType 均
/// 取自 SDK 头文件的 C 枚举原始值。
type IOReturn = i32;
type IOOptionBits = u32;

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
/// CFNumberType.kCFNumberIntType。
const K_CF_NUMBER_INT_TYPE: CFIndex = 9;
const K_IOHID_OPTIONS_TYPE_NONE: IOOptionBits = 0x00;
/// IOHIDOptionsType.kIOHIDOptionsTypeSeizeDevice（仅消费者页节点兜底使用）。
const K_IOHID_OPTIONS_TYPE_SEIZE_DEVICE: IOOptionBits = 0x01;
/// IOHIDRequestType.kIOHIDRequestTypeListenEvent（kIOHIDRequestTypePostEvent = 0）。
const K_IOHID_REQUEST_TYPE_LISTEN_EVENT: u32 = 1;
/// IOHIDAccessType.kIOHIDAccessTypeGranted（Denied = 1，Unknown = 2）。
const K_IOHID_ACCESS_TYPE_GRANTED: i32 = 0;
/// IOHIDReportType.kIOHIDReportTypeInput（Output = 1，Feature = 2）。
const K_IOHID_REPORT_TYPE_INPUT: u32 = 0;
const K_IO_RETURN_SUCCESS: IOReturn = 0;

type IOHIDDeviceCallbackFn =
    unsafe extern "C" fn(*mut c_void, IOReturn, *mut c_void, IOHIDDeviceRef);
type IOHIDReportCallbackFn =
    unsafe extern "C" fn(*mut c_void, IOReturn, *mut c_void, u32, u32, *mut u8, CFIndex);

#[repr(C)]
struct CFDictionaryKeyCallBacks {
    version: CFIndex,
    retain: Option<unsafe extern "C" fn(CFAllocatorRef, *const c_void) -> *const c_void>,
    release: Option<unsafe extern "C" fn(CFAllocatorRef, *const c_void)>,
    copy_description: Option<unsafe extern "C" fn(*const c_void) -> CFStringRef>,
    equal: Option<unsafe extern "C" fn(*const c_void, *const c_void) -> bool>,
    hash: Option<unsafe extern "C" fn(*const c_void) -> CFIndex>,
}

#[repr(C)]
struct CFDictionaryValueCallBacks {
    version: CFIndex,
    retain: Option<unsafe extern "C" fn(CFAllocatorRef, *const c_void) -> *const c_void>,
    release: Option<unsafe extern "C" fn(CFAllocatorRef, *const c_void)>,
    copy_description: Option<unsafe extern "C" fn(*const c_void) -> CFStringRef>,
    equal: Option<unsafe extern "C" fn(*const c_void, *const c_void) -> bool>,
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOHIDManagerCreate(allocator: CFAllocatorRef, options: IOOptionBits) -> IOHIDManagerRef;
    fn IOHIDManagerOpen(manager: IOHIDManagerRef, options: IOOptionBits) -> IOReturn;
    fn IOHIDManagerSetDeviceMatching(manager: IOHIDManagerRef, matching: CFDictionaryRef);
    fn IOHIDManagerScheduleWithRunLoop(
        manager: IOHIDManagerRef,
        run_loop: CFRunLoopRef,
        mode: CFStringRef,
    );
    fn IOHIDManagerRegisterDeviceMatchingCallback(
        manager: IOHIDManagerRef,
        callback: IOHIDDeviceCallbackFn,
        context: *mut c_void,
    );
    fn IOHIDManagerRegisterDeviceRemovalCallback(
        manager: IOHIDManagerRef,
        callback: IOHIDDeviceCallbackFn,
        context: *mut c_void,
    );
    fn IOHIDManagerRegisterInputReportCallback(
        manager: IOHIDManagerRef,
        callback: IOHIDReportCallbackFn,
        context: *mut c_void,
    );
    fn IOHIDDeviceOpen(device: IOHIDDeviceRef, options: IOOptionBits) -> IOReturn;
    fn IOHIDDeviceClose(device: IOHIDDeviceRef, options: IOOptionBits) -> IOReturn;
    /// 返回 CFTypeRef；DeviceUsagePage 等数值属性为 CFNumber。
    fn IOHIDDeviceGetProperty(device: IOHIDDeviceRef, key: CFStringRef) -> *const c_void;
    /// 返回值即 IOHIDAccessType：0=Granted 1=Denied 2=Unknown。
    fn IOHIDCheckAccess(request_type: u32) -> i32;
    /// 返回值：C bool（用户在系统设置中允许后为真）。
    fn IOHIDRequestAccess(request_type: u32) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: CFStringRef;
    static kCFCopyStringDictionaryKeyCallBacks: CFDictionaryKeyCallBacks;
    static kCFTypeDictionaryValueCallBacks: CFDictionaryValueCallBacks;
    fn CFStringCreateWithCString(
        allocator: CFAllocatorRef,
        c_str: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFNumberCreate(
        allocator: CFAllocatorRef,
        number_type: CFIndex,
        value_ptr: *const c_void,
    ) -> CFNumberRef;
    fn CFNumberGetValue(
        number: CFNumberRef,
        the_type: CFIndex,
        value_ptr: *mut c_void,
    ) -> bool;
    /// 属性值类型校验：非 CFNumber 的值直接放弃，防止把 CFString 等当数字读。
    fn CFGetTypeID(cf: *const c_void) -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFDictionaryCreate(
        allocator: CFAllocatorRef,
        keys: *const *const c_void,
        values: *const *const c_void,
        num_values: CFIndex,
        key_callbacks: *const CFDictionaryKeyCallBacks,
        value_callbacks: *const CFDictionaryValueCallBacks,
    ) -> CFDictionaryRef;
}

// libdispatch（libSystem 自带）：把节点重试投递回主线程执行，
// 与设备移除回调（主 RunLoop）天然串行，避免对已移除节点悬垂打开。
// dispatch_get_main_queue() 在 SDK 里是宏，实际符号是全局对象 _dispatch_main_q。
extern "C" {
    static _dispatch_main_q: *mut c_void;
    fn dispatch_async_f(queue: *mut c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
}

// ---- 纯逻辑：报文解析、按键名、边沿 diff（可单测） ----

/// 把一条原始输入报文解析为 usage 集合（升序去重）。
///
/// 该遥控器存在两种已知的 report ID 1 布局，真机确认前两种都支持：
/// - 紧凑布局（6/7 字节）：usage 的 u16 小端数组（SayAll 生产解析器所见）；
/// - 标准键盘布局（10/11 字节）：修饰(1) 保留(1) LED(1) 保留(1) + 6 个
///   单字节键位槽（艾特阅读 2026-08 抓包的 report descriptor 所见）。
/// 未识别形状返回 None，由调用方记一条去重后的原始十六进制日志。
pub(crate) fn parse_report(report_id: u32, data: &[u8]) -> Option<Vec<u16>> {
    if report_id != 1 || data.is_empty() {
        return None;
    }
    // 奇数长度且首字节等于 report ID：剥掉 1 字节 ID 前缀。
    let payload = if data.len() % 2 == 1 && data[0] == report_id as u8 {
        &data[1..]
    } else {
        data
    };
    let mut usages: Vec<u16> = Vec::new();
    if payload.len() == 10 {
        // 标准键盘布局；修饰键字节不属于按键 usage，忽略。
        usages.extend(
            payload[4..10]
                .iter()
                .filter(|b| **b != 0)
                .map(|b| *b as u16),
        );
    } else if payload.len() % 2 == 0 {
        for pair in payload.chunks_exact(2) {
            let usage = u16::from_le_bytes([pair[0], pair[1]]);
            if usage != 0 {
                usages.push(usage);
            }
        }
    } else {
        return None;
    }
    usages.sort_unstable();
    usages.dedup();
    Some(usages)
}

/// 键盘页 usage → 稳定按键名（与注入层/菜单约定解耦的语义名）。
/// 已知映射来自遥控器实测与 SayAll 公开的按键表。
pub(crate) fn usage_name(usage: u16) -> Option<&'static str> {
    Some(match usage {
        0x28 => "ok",
        0x35 => "tv",
        0x3E => "voice",
        0x4A => "home",
        0x4F => "left",
        0x50 => "right",
        0x51 => "down",
        0x52 => "up",
        0x65 => "menu",
        0x66 => "power",
        0x80 => "volume_up",
        0x81 => "volume_down",
        0xF1 => "back",
        _ => return None,
    })
}

/// 上次 usage 集合 → 本次集合的按下/松开边沿。
pub(crate) fn diff_edges(prev: &HashSet<u16>, next: &HashSet<u16>) -> (Vec<u16>, Vec<u16>) {
    let pressed: Vec<u16> = next
        .iter()
        .filter(|u| !prev.contains(*u))
        .copied()
        .collect();
    let released: Vec<u16> = prev
        .iter()
        .filter(|u| !next.contains(*u))
        .copied()
        .collect();
    (pressed, released)
}

// ---- 和弦状态机（真机实测协议，2026-10-30 标注复测） ----
//
// 本机固件（Realtek BT，固件 18667）对系统无法映射的按键使用「字母和弦」编码：
// report id 1 报文 byte1=0x08（键盘页 E）为和弦族标志，实际键码在第三字节：
//   {0x08}        → E 单独（观察到的完整手势：{E} → {E,码} → {码} → {}）
//   {0x08,0x2B}   → E+Tab 和弦
//   {0x08,0x14}   → E+Y 和弦
// 和弦松开是逐帧退场（先撤 E 再撤码），逐 usage 边沿会把中间帧伪造成 E 单击，
// 因此必须做集合级解释：整个手势只产出一次按下/一次松开。
// 语音键不在键盘页：走厂商通道 report id 2（见 on_input_report）。

/// 报文 usage 集合对应的单一逻辑键。
#[derive(Clone, PartialEq, Debug, Default)]
pub(crate) enum LogicalKey {
    #[default]
    Idle,
    /// 命名键（和弦或已知标准键）。
    Key(&'static str),
    /// 多个已知标准键同按（本固件未出现，保守保留逐 usage 边沿路径）。
    Set,
    /// 无法解释的集合，走十六进制抓取日志。
    Unknown,
}

/// 把一帧报文的 usage 集合（须为 parse_report 输出的升序序列）解释为逻辑键。
pub(crate) fn classify_usages(usages: &[u16]) -> LogicalKey {
    match usages {
        [] => LogicalKey::Idle,
        [0x08] => LogicalKey::Key("key_E"),
        // 和弦尾帧（E 已撤、码残留）视为同一和弦的持续
        [0x08, 0x14] | [0x14] => LogicalKey::Key("chord_E_Y"),
        [0x08, 0x2B] | [0x2B] => LogicalKey::Key("chord_E_Tab"),
        [single] => match usage_name(*single) {
            Some(name) => LogicalKey::Key(name),
            None => LogicalKey::Unknown,
        },
        many if !many.is_empty() && many.iter().all(|u| usage_name(*u).is_some()) => {
            LogicalKey::Set
        }
        _ => LogicalKey::Unknown,
    }
}

/// 逻辑键引用：命名键或原始 usage。
#[derive(Clone, Copy, Debug)]
pub(crate) enum ButtonRef {
    Named(&'static str),
    Usage(u16),
}

/// 两次分类之间的按键事件序列。
pub(crate) fn logical_transitions(
    prev: &LogicalKey,
    next: &LogicalKey,
    prev_usages: &HashSet<u16>,
    next_usages: &HashSet<u16>,
) -> Vec<(ButtonRef, &'static str)> {
    use LogicalKey::*;
    let mut events = Vec::new();
    match (prev, next) {
        (Key(a), Key(b)) => {
            if a != b {
                events.push((ButtonRef::Named(a), "release"));
                events.push((ButtonRef::Named(b), "press"));
            }
        }
        (Key(a), Idle) | (Key(a), Unknown) => {
            events.push((ButtonRef::Named(a), "release"));
        }
        (Key(a), Set) => {
            events.push((ButtonRef::Named(a), "release"));
            for u in next_usages {
                events.push((ButtonRef::Usage(*u), "press"));
            }
        }
        (Idle, Key(b)) | (Unknown, Key(b)) => {
            events.push((ButtonRef::Named(b), "press"));
        }
        (Set, Key(b)) => {
            for u in prev_usages {
                events.push((ButtonRef::Usage(*u), "release"));
            }
            events.push((ButtonRef::Named(b), "press"));
        }
        (Idle, Set) | (Unknown, Set) => {
            for u in next_usages {
                events.push((ButtonRef::Usage(*u), "press"));
            }
        }
        (Set, Idle) | (Set, Unknown) => {
            for u in prev_usages {
                events.push((ButtonRef::Usage(*u), "release"));
            }
        }
        (Set, Set) => {
            let (pressed, released) = diff_edges(prev_usages, next_usages);
            for u in released {
                events.push((ButtonRef::Usage(u), "release"));
            }
            for u in pressed {
                events.push((ButtonRef::Usage(u), "press"));
            }
        }
        (Idle, Idle) | (Idle, Unknown) | (Unknown, Idle) | (Unknown, Unknown) => {}
    }
    events
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

/// 未识别报文的「稳定区」签名，用于把厂商周期性遥测去重成一条日志。
/// 真机实测：105 字节遥测流的前 4 字节是计数、第 5-7 字节是随机数、其余恒定；
/// 5 字节握手报文仅末字节自增。因此长报文取 12 字节之后的尾部，短报文去掉末字节。
pub(crate) fn stable_signature(data: &[u8]) -> String {
    if data.len() > 12 {
        to_hex(&data[12..])
    } else {
        to_hex(&data[..data.len().saturating_sub(1)])
    }
}

/// 未识别报文是否值得记日志：每类前 3 条必记（留原始样本），之后仅稳定区
/// 签名变化时记——按键事件若藏在该类报文中，必然改变稳定区。
pub(crate) fn should_log_unknown_shape(seen: u32, prev_signature: Option<&str>, signature: &str) -> bool {
    seen <= 3 || prev_signature != Some(signature)
}

// ---- 运行时：监听器生命周期与事件广播 ----

#[derive(Default)]
struct HidState {
    active_usages: HashSet<u16>,
    /// 当前逻辑键（和弦状态机）。
    current_key: LogicalKey,
    /// 语音键厂商通道的当前状态。
    voice_active: bool,
    /// 未识别报文按 (report_id, len) 类别去重：(出现次数, 上次稳定区签名)。
    unknown_shapes: HashMap<(u32, usize), (u32, Option<String>)>,
    /// 已记录过 hex 的成功解析报文（抓取模式，有界防膨胀）。
    seen_report_hex: HashSet<String>,
    seen_first_report: bool,
}

/// 成功解析报文的抓取日志上限。
const SEEN_REPORT_HEX_CAP: usize = 512;

struct HidContext {
    app: AppHandle<Wry>,
    state: Mutex<HidState>,
    /// VID/PID 匹配到的节点：地址 → 打开状态（失败节点由重试线程补开）。
    nodes: Mutex<HashMap<usize, NodeState>>,
}

#[derive(Default)]
struct NodeState {
    opened: bool,
    attempts: u32,
}

static STARTED: AtomicBool = AtomicBool::new(false);

/// 启动遥控器 HID 监听（幂等）。在 lib.rs setup（主线程）调用一次。
pub fn start(app: &AppHandle<Wry>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let access = unsafe { IOHIDCheckAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) };
    log::info!(target: TARGET, "输入监控权限状态 access={access}（0=已授权 1=拒绝 2=未决定）");
    if access != K_IOHID_ACCESS_TYPE_GRANTED {
        let requested = unsafe { IOHIDRequestAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) };
        log::info!(
            target: TARGET,
            "已请求输入监控权限 request_granted={requested}；首次使用需在 \
             系统设置 → 隐私与安全性 → 输入监控 中允许艾特阅读"
        );
    }

    // 回调上下文与应用同生命周期，刻意不回收。
    let context = Arc::into_raw(Arc::new(HidContext {
        app: app.clone(),
        state: Mutex::new(HidState::default()),
        nodes: Mutex::new(HashMap::new()),
    })) as *mut HidContext;

    let manager = unsafe {
        let manager = IOHIDManagerCreate(std::ptr::null(), K_IOHID_OPTIONS_TYPE_NONE);
        let keys = [cf_string("VendorID"), cf_string("ProductID")];
        let values = [
            cf_number_int(XIAOMI_VENDOR_ID),
            cf_number_int(XIAOMI_PRODUCT_ID),
        ];
        let matching = CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            2,
            &kCFCopyStringDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        );
        IOHIDManagerSetDeviceMatching(manager, matching);
        IOHIDManagerRegisterDeviceMatchingCallback(manager, on_device_matched, context.cast());
        IOHIDManagerRegisterDeviceRemovalCallback(manager, on_device_removed, context.cast());
        IOHIDManagerRegisterInputReportCallback(manager, on_input_report, context.cast());
        IOHIDManagerScheduleWithRunLoop(
            manager,
            // setup 在主线程执行，主 RunLoop 由 Tauri 事件循环驱动。
            run_loop_main(),
            kCFRunLoopCommonModes,
        );
        manager
    };

    let open_result = unsafe { IOHIDManagerOpen(manager, K_IOHID_OPTIONS_TYPE_NONE) };
    if open_result == K_IO_RETURN_SUCCESS {
        log::info!(target: TARGET, "HID 监听已打开（监听模式）");
    } else {
        log::warn!(
            target: TARGET,
            "HID 监听打开失败 result={open_result}(0x{:X})（权限未授予或被占用），进入授权等待重试",
            open_result as u32
        );
        spawn_open_retry(manager as usize);
    }
    // 节点打开失败（授权窗口期瞬时失败）的补开清扫。
    spawn_node_retry(context);
    // manager 为进程级单例，保持打开状态直到进程退出，无关闭路径。
    let _ = manager;
}

/// 创建 CFString。必须用 CString 保证 NUL 结尾：&str 不是 NUL 结尾，
/// 直接把 as_ptr 交给 CFStringCreateWithCString 会越界读，某些布局下
/// 返回 NULL，下游 IOHIDDeviceGetProperty 对 NULL 键求长度即段错误
/// （2026-10-31 启动崩溃事故，崩溃报告定位于此）。
unsafe fn cf_string(value: &str) -> CFStringRef {
    let c = CString::new(value).expect("HID 属性名不含 NUL");
    CFStringCreateWithCString(
        std::ptr::null(),
        c.as_ptr(),
        K_CF_STRING_ENCODING_UTF8,
    )
}

unsafe fn cf_number_int(value: i32) -> CFNumberRef {
    CFNumberCreate(
        std::ptr::null(),
        K_CF_NUMBER_INT_TYPE,
        &value as *const i32 as *const c_void,
    )
}

unsafe fn run_loop_main() -> CFRunLoopRef {
    // CFRunLoopGetMain 未在精简绑定里重复声明，直接内联外部符号。
    extern "C" {
        fn CFRunLoopGetMain() -> CFRunLoopRef;
    }
    CFRunLoopGetMain()
}

/// 打开失败（通常是授权未完成）时的有界重试；线程侧只持地址值。
fn spawn_open_retry(manager_addr: usize) {
    std::thread::spawn(move || {
        let manager = manager_addr as IOHIDManagerRef;
        for attempt in 1..=OPEN_RETRY_ATTEMPTS {
            std::thread::sleep(OPEN_RETRY_INTERVAL);
            if unsafe { IOHIDCheckAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) }
                != K_IOHID_ACCESS_TYPE_GRANTED
            {
                continue;
            }
            let result = unsafe { IOHIDManagerOpen(manager, K_IOHID_OPTIONS_TYPE_NONE) };
            if result == K_IO_RETURN_SUCCESS {
                log::info!(target: TARGET, "输入监控授权完成，HID 监听已打开（第 {attempt} 次重试）");
                return;
            }
            log::warn!(target: TARGET, "HID 监听重试失败 attempt={attempt} result={result}");
        }
        log::warn!(
            target: TARGET,
            "HID 监听未能打开：请在 系统设置 → 隐私与安全性 → 输入监控 中允许艾特阅读后重启应用"
        );
    });
}

unsafe fn read_device_property_i32(device: IOHIDDeviceRef, key: &str) -> Option<i32> {
    let key_ref = cf_string(key);
    if key_ref.is_null() {
        return None;
    }
    let value = IOHIDDeviceGetProperty(device, key_ref);
    if value.is_null() {
        return None;
    }
    if CFGetTypeID(value) != CFNumberGetTypeID() {
        return None;
    }
    let mut out: i32 = 0;
    if CFNumberGetValue(
        value as CFNumberRef,
        K_CF_NUMBER_INT_TYPE,
        &mut out as *mut i32 as *mut c_void,
    ) {
        Some(out)
    } else {
        None
    }
}

fn mark_node(context: *mut c_void, device: IOHIDDeviceRef, opened: bool) {
    if let Some(ctx) = context_ref(context) {
        if let Ok(mut nodes) = ctx.nodes.lock() {
            if let Some(state) = nodes.get_mut(&(device as usize)) {
                state.opened = opened;
                state.attempts += 1;
            }
        }
    }
}

/// 节点身份描述（日志用）：LocationID + 用途页。DeviceUsagePage 在本机
/// 恒为 None，PrimaryUsagePage 是可用性更好的替代。
unsafe fn node_identity(device: IOHIDDeviceRef) -> String {
    let location = read_device_property_i32(device, "LocationID");
    let primary_page = read_device_property_i32(device, "PrimaryUsagePage");
    let primary_usage = read_device_property_i32(device, "PrimaryUsage");
    format!("location={location:?} primary_page={primary_page:?} primary_usage={primary_usage:?}")
}

/// 打开单个节点（监听模式；被独占持有且可排除键盘页时夺取兜底）。
/// 0xE00002C5 = kIOReturnExclusiveAccess：节点被其他进程（如 SayAll 这类
/// 会 seize 遥控器的工具）或系统栈独占，重试无效，只有夺取或持有者退出。
unsafe fn open_node(context: *mut c_void, device: IOHIDDeviceRef) -> bool {
    let identity = node_identity(device);
    let result = IOHIDDeviceOpen(device, K_IOHID_OPTIONS_TYPE_NONE);
    if result == K_IO_RETURN_SUCCESS {
        log::info!(target: TARGET, "设备节点已监听打开 {identity}");
        mark_node(context, device, true);
        return true;
    }
    log::warn!(
        target: TARGET,
        "设备节点监听打开失败 {identity} result={result}(0x{:X})，等待重试",
        result as u32
    );
    // 夺取兜底：仅当 PrimaryUsagePage 可读且明确不是键盘页（1）时执行，
    // 避免夺取键盘节点打断方向/OK 等系统路径。系统本就不消费消费者页
    // （不映射 report 241），夺取不改变既有行为。
    let primary_page = read_device_property_i32(device, "PrimaryUsagePage");
    if primary_page.is_some() && primary_page != Some(1) {
        let seized = IOHIDDeviceOpen(device, K_IOHID_OPTIONS_TYPE_SEIZE_DEVICE);
        if seized == K_IO_RETURN_SUCCESS {
            log::info!(target: TARGET, "节点已从独占持有者夺取打开（非键盘页）{identity}");
            mark_node(context, device, true);
            return true;
        }
        log::warn!(
            target: TARGET,
            "节点夺取失败 {identity} result={seized}(0x{:X})（持有者可能是 SayAll 等 HID 工具，需其退出）",
            seized as u32
        );
    }
    mark_node(context, device, false);
    false
}

/// 主线程上执行：补开所有失败未超限的节点并打一条状态汇总。
/// 与设备移除回调同在主线程串行，不会对已移除节点悬垂打开。
extern "C" fn sweep_pending_opens(context: *mut c_void) {
    let Some(ctx) = context_ref(context) else {
        return;
    };
    let pending: Vec<usize> = {
        let Ok(nodes) = ctx.nodes.lock() else {
            return;
        };
        nodes
            .iter()
            .filter(|(_, state)| !state.opened && state.attempts < NODE_OPEN_MAX_ATTEMPTS)
            .map(|(addr, _)| *addr)
            .collect()
    };
    for addr in pending {
        let device = addr as IOHIDDeviceRef;
        unsafe { open_node(context, device) };
    }
    if let Ok(nodes) = ctx.nodes.lock() {
        let opened = nodes.values().filter(|state| state.opened).count();
        let still_pending = nodes.values().filter(|state| !state.opened).count();
        if still_pending > 0 {
            log::info!(target: TARGET, "节点打开状态 已打开={opened} 待重试={still_pending}");
        }
    }
}

/// 节点打开重试线程：固定窗口内每 5 秒向主线程投递一次清扫。
/// 上下文以地址值传递（与 open 重试线程同一模式），实际打开在主线程执行。
fn spawn_node_retry(context: *mut HidContext) {
    let context_addr = context as usize;
    std::thread::spawn(move || {
        for _ in 0..NODE_OPEN_MAX_ATTEMPTS {
            std::thread::sleep(NODE_OPEN_RETRY_INTERVAL);
            let context = context_addr as *mut c_void;
            unsafe {
                let main_queue = std::ptr::addr_of!(_dispatch_main_q)
                    .cast::<c_void>()
                    .cast_mut();
                dispatch_async_f(main_queue, context, sweep_pending_opens);
            }
        }
    });
}

unsafe extern "C" fn on_device_matched(
    context: *mut c_void,
    result: IOReturn,
    _sender: *mut c_void,
    device: IOHIDDeviceRef,
) {
    if result != K_IO_RETURN_SUCCESS {
        log::warn!(target: TARGET, "遥控器匹配回调异常 result={result}");
        return;
    }
    log::info!(target: TARGET, "遥控器已连接");
    if device.is_null() {
        return;
    }
    // 预先建立 ATVV 语音链路：语音键随时可临时收音，不依赖语音翻页开关。
    crate::remote_voice::ensure_started();
    // 节点级监听打开：SayAll 的生产路径。键盘页(1)与消费者页(12)是两个节点，
    // 消费者节点的报文（音量/返回）可能只有节点级打开后才投递。
    if let Some(ctx) = context_ref(context) {
        if let Ok(mut nodes) = ctx.nodes.lock() {
            nodes.entry(device as usize).or_default();
        }
    }
    open_node(context, device);
}

unsafe extern "C" fn on_device_removed(
    context: *mut c_void,
    _result: IOReturn,
    _sender: *mut c_void,
    device: IOHIDDeviceRef,
) {
    if let Some(ctx) = context_ref(context) {
        if let Ok(mut state) = ctx.state.lock() {
            state.active_usages.clear();
            state.current_key = LogicalKey::Idle;
            state.voice_active = false;
        }
        if let Ok(mut nodes) = ctx.nodes.lock() {
            if let Some(node) = nodes.remove(&(device as usize)) {
                if node.opened {
                    IOHIDDeviceClose(device, K_IOHID_OPTIONS_TYPE_NONE);
                }
            }
        }
    }
    log::info!(target: TARGET, "遥控器已断开");
}

unsafe extern "C" fn on_input_report(
    context: *mut c_void,
    result: IOReturn,
    _sender: *mut c_void,
    report_type: u32,
    report_id: u32,
    report: *mut u8,
    report_length: CFIndex,
) {
    if result != K_IO_RETURN_SUCCESS || report_type != K_IOHID_REPORT_TYPE_INPUT {
        return;
    }
    if report_length <= 0 || report.is_null() {
        return;
    }
    let Some(ctx) = context_ref(context) else {
        return;
    };
    let data = std::slice::from_raw_parts(report, report_length as usize);

    // 语音键走厂商通道：id=2 len=65 报文对（实测 02 CF 00…=按下、02 00 00…=松开，
    // 按住 2-3 秒）。按下帧 byte1 非零、松开帧其余全零。
    if report_id == 2 && data.len() == 65 {
        let released = data[1..].iter().all(|&b| b == 0);
        let Ok(mut state) = ctx.state.lock() else {
            return;
        };
        let was_active = state.voice_active;
        state.voice_active = !released;
        drop(state);
        if !released && !was_active {
            emit_button_ref(ctx, ButtonRef::Named("voice"), "press");
        } else if released && was_active {
            emit_button_ref(ctx, ButtonRef::Named("voice"), "release");
        }
        return;
    }

    let Ok(mut state) = ctx.state.lock() else {
        return;
    };
    if !state.seen_first_report {
        state.seen_first_report = true;
        log::info!(target: TARGET, "收到首条输入报文（监听模式生效）");
    }
    let Some(usages) = parse_report(report_id, data) else {
        let hex = to_hex(data);
        let class = (report_id, data.len());
        let entry = state.unknown_shapes.entry(class).or_insert((0, None));
        entry.0 += 1;
        let signature = stable_signature(data);
        if should_log_unknown_shape(entry.0, entry.1.as_deref(), &signature) {
            log::info!(
                target: TARGET,
                "未识别报文形状 id={report_id} len={} hex={hex}",
                data.len()
            );
            entry.1 = Some(signature);
        }
        return;
    };
    // 抓取模式：同一 hex 的成功解析报文只记一次，用于真机核对固件布局。
    let hex = to_hex(data);
    if state.seen_report_hex.len() < SEEN_REPORT_HEX_CAP && state.seen_report_hex.insert(hex.clone())
    {
        let usage_list = usages
            .iter()
            .map(|u| format!("{u:04X}"))
            .collect::<Vec<_>>()
            .join(",");
        log::info!(
            target: TARGET,
            "报文 id={report_id} len={} hex={hex} usages={usage_list}",
            data.len()
        );
    }

    let next: HashSet<u16> = usages.iter().copied().collect();
    let next_key = classify_usages(&usages);
    let events = logical_transitions(&state.current_key, &next_key, &state.active_usages, &next);
    state.current_key = next_key;
    state.active_usages = next;
    // 先落地状态再广播，回调内不做可能重入的耗时工作。
    drop(state);
    for (button, phase) in events {
        emit_button_ref(ctx, button, phase);
    }
}

fn context_ref<'a>(context: *mut c_void) -> Option<&'a HidContext> {
    if context.is_null() {
        None
    } else {
        Some(unsafe { &*(context as *const HidContext) })
    }
}

fn emit_button_ref(ctx: &HidContext, button: ButtonRef, phase: &str) {
    let (name, usage) = match button {
        ButtonRef::Named(name) => (name.to_string(), 0u16),
        ButtonRef::Usage(u) => match usage_name(u) {
            Some(name) => (name.to_string(), u),
            None => (format!("usage_0x{u:02X}"), u),
        },
    };
    log::info!(target: TARGET, "按键 {name} {phase}");
    if name == "voice" && phase == "press" {
        // 语音键按下：语音翻页开关关闭时也临时启用 PTT 识别。
        crate::voice_turner::remote_voice_key_pressed(&ctx.app);
    }
    let Some(win) = ctx.app.get_webview_window("main") else {
        return;
    };
    let _ = win.emit(
        BUTTON_EVENT,
        json!({ "button": name, "phase": phase, "usage": usage }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(values: &[u16]) -> HashSet<u16> {
        values.iter().copied().collect()
    }

    #[test]
    fn parse_compact_layout_with_and_without_report_id() {
        // 3 组 u16 小端 usage，音量+ 在第一组
        assert_eq!(
            parse_report(1, &[0x80, 0x00, 0x00, 0x00, 0x00, 0x00]),
            Some(vec![0x80])
        );
        // 带 1 字节 report ID 前缀
        assert_eq!(
            parse_report(1, &[0x01, 0xF1, 0x00, 0x00, 0x00, 0x00, 0x00]),
            Some(vec![0xF1])
        );
    }

    #[test]
    fn parse_standard_keyboard_layout() {
        // 11 字节：ID + 修饰 + 保留 + LED + 保留 + 6 键位槽
        let report = [
            0x01, 0x00, 0x00, 0x00, 0x00, 0x52, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        assert_eq!(parse_report(1, &report), Some(vec![0x52]));
        // 两键同时按下
        let report = [
            0x01, 0x00, 0x00, 0x00, 0x00, 0x52, 0x28, 0x00, 0x00, 0x00, 0x00,
        ];
        assert_eq!(parse_report(1, &report), Some(vec![0x28, 0x52]));
    }

    #[test]
    fn parse_rejects_unknown_shapes() {
        assert_eq!(parse_report(2, &[0x02, 0x00]), None);
        assert_eq!(parse_report(1, &[]), None);
        // 奇数长度且首字节不是 report ID：无法解析
        assert_eq!(parse_report(1, &[0x07, 0x00, 0x00]), None);
    }

    #[test]
    fn usage_names_cover_xiaomi_layout() {
        let expected: [(u16, &str); 13] = [
            (0x28, "ok"),
            (0x35, "tv"),
            (0x3E, "voice"),
            (0x4A, "home"),
            (0x4F, "left"),
            (0x50, "right"),
            (0x51, "down"),
            (0x52, "up"),
            (0x65, "menu"),
            (0x66, "power"),
            (0x80, "volume_up"),
            (0x81, "volume_down"),
            (0xF1, "back"),
        ];
        for (usage, name) in expected {
            assert_eq!(usage_name(usage), Some(name));
        }
        assert_eq!(usage_name(0x999), None);
    }

    #[test]
    fn diff_edges_reports_press_and_release() {
        let prev = set(&[0x52, 0x80]);
        let next = set(&[0x52, 0xF1]);
        let (pressed, released) = diff_edges(&prev, &next);
        assert_eq!(pressed, vec![0xF1]);
        assert_eq!(released, vec![0x80]);
    }

    #[test]
    fn stable_signature_ignores_volatile_regions() {
        // 长报文：12 字节之后的稳定区，前缀计数/随机数变化不影响签名
        let a = stable_signature(&[vec![0xEC, 0xF2, 0x7C, 0x00, 0x00, 0x99, 0xBC, 0xE6, 0x20, 0x4A], vec![0u8; 20]].concat());
        let b = stable_signature(&[vec![0xEC, 0xF3, 0x7C, 0x00, 0x00, 0x3C, 0x91, 0xEC, 0x20, 0x4A], vec![0u8; 20]].concat());
        assert_eq!(a, b);
        // 稳定区变化（疑似按键状态）必须改变签名
        let mut c = vec![0u8; 30];
        c[20] = 1;
        assert_ne!(a, stable_signature(&c));
        // 短报文：去掉末字节（自增序号）
        assert_eq!(stable_signature(&[3, 2, 0, 0, 1]), stable_signature(&[3, 2, 0, 0, 2]));
        assert_eq!(stable_signature(&[3, 2, 0, 0, 1]), "03020000");
    }

    #[test]
    fn should_log_unknown_shape_rules() {
        // 每类前 3 条必记
        assert!(should_log_unknown_shape(1, Some("AA"), "AA"));
        assert!(should_log_unknown_shape(3, None, "AA"));
        // 之后仅签名变化时记
        assert!(!should_log_unknown_shape(4, Some("AA"), "AA"));
        assert!(should_log_unknown_shape(4, Some("AA"), "BB"));
        assert!(should_log_unknown_shape(4, None, "AA"));
    }

    #[test]
    fn classify_covers_firmware_protocol() {
        assert_eq!(classify_usages(&[]), LogicalKey::Idle);
        assert_eq!(classify_usages(&[0x08]), LogicalKey::Key("key_E"));
        assert_eq!(classify_usages(&[0x08, 0x14]), LogicalKey::Key("chord_E_Y"));
        // 和弦尾帧（E 已撤、码残留）视为同一和弦
        assert_eq!(classify_usages(&[0x14]), LogicalKey::Key("chord_E_Y"));
        assert_eq!(classify_usages(&[0x08, 0x2B]), LogicalKey::Key("chord_E_Tab"));
        assert_eq!(classify_usages(&[0x2B]), LogicalKey::Key("chord_E_Tab"));
        // 标准键照旧
        assert_eq!(classify_usages(&[0x28]), LogicalKey::Key("ok"));
        assert_eq!(classify_usages(&[0x66]), LogicalKey::Key("power"));
        // 多个已知标准键 / 未知集合
        assert_eq!(classify_usages(&[0x28, 0x52]), LogicalKey::Set);
        assert_eq!(classify_usages(&[0x99]), LogicalKey::Unknown);
        assert_eq!(classify_usages(&[0x08, 0x99]), LogicalKey::Unknown);
    }

    fn replay<F>(frames: &[&[u16]], mut on_event: F)
    where
        F: FnMut(ButtonRef, &'static str),
    {
        let mut prev = LogicalKey::Idle;
        let mut prev_usages: HashSet<u16> = HashSet::new();
        for frame in frames {
            let next = classify_usages(frame);
            let next_usages: HashSet<u16> = frame.iter().copied().collect();
            for (button, phase) in
                logical_transitions(&prev, &next, &prev_usages, &next_usages)
            {
                on_event(button, phase);
            }
            prev = next;
            prev_usages = next_usages;
        }
    }

    #[test]
    fn chord_gesture_yields_single_press_release_pair() {
        // 实测手势帧序：{} → {E} → {E,Tab} → {Tab} → {}
        let mut pressed: Vec<String> = Vec::new();
        let mut released: Vec<String> = Vec::new();
        replay(
            &[&[], &[0x08], &[0x08, 0x2B], &[0x2B], &[]],
            |button, phase| {
                let name = match button {
                    ButtonRef::Named(n) => n.to_string(),
                    ButtonRef::Usage(u) => format!("usage_0x{u:02X}"),
                };
                if phase == "press" {
                    pressed.push(name)
                } else {
                    released.push(name)
                }
            },
        );
        // 前导 {E} 帧产生一次 key_E 边沿对，整手势只产生一次 chord 按下/松开，
        // 尾帧 {Tab} 不产生任何伪边沿
        assert_eq!(pressed, vec!["key_E".to_string(), "chord_E_Tab".to_string()]);
        assert_eq!(released, vec!["key_E".to_string(), "chord_E_Tab".to_string()]);
    }

    #[test]
    fn chord_without_leading_frame_and_standard_keys() {
        // 无前导帧的和弦（多数情况）：{} → {E,Tab} → {} 一次边沿对
        let mut count = 0;
        replay(&[&[], &[0x08, 0x2B], &[]], |_, _| {
            count += 1;
        });
        assert_eq!(count, 2);

        // 标准键沿用命名按键：{} → {0x28} → {}
        let mut events: Vec<(&str, &str)> = Vec::new();
        replay(&[&[], &[0x28], &[]], |button, phase| {
            if let ButtonRef::Named(name) = button {
                events.push((name, phase));
            }
        });
        assert_eq!(events, vec![("ok", "press"), ("ok", "release")]);
    }
}
