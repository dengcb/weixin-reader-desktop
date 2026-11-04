//! ATVV 语音翻页客户端（macOS，三期）。
//!
//! 小米遥控器的语音走 Android TV 私有 ATVV 服务（GATT），macOS 不认识它；
//! 本模块充当遥控器专属的语音客户端：系统蓝牙栈只搬运字节，语义由本模块
//! 与遥控器按 ATVV 协议约定（机制参照 remote-mic / SayAll，GPL-3.0，
//! 只学机制不抄代码；ADPCM 为公开 IMA 算法）。
//!
//! 型号边界：二代普通版与 Pro（2 / 2 Pro）均提供 ATVV；普通版已真机验证，
//! Pro/RC003 依据参考实现（同为高半字节优先），待真机复验。一代
//! （RTKBee，PID 0x32B8，固件 18667）在 Mac 配对下 GATT 只有电池/设备信息/
//! Wiced Smart，语音键仅发 HID F5，没有任何麦克风通道；本模块连接后检测到
//! ATVV 缺失即停止重连，不再尝试。
//!
//! 协议规格（真机与参考实现核对）：
//! - 服务 `AB5E0001-5A21-4F05-BC7D-AF01F617B664`；特征：AB5E0002 下行命令
//!   （写）、AB5E0003 上行音频（通知）、AB5E0004 上行控制（通知）。
//! - 建链：缓存标识直连 → 系统已连外设（HID/电池/ATVV 种子服务，按名称过滤）
//!   → 扫描配对广播 → connect → 发现特征 → 订阅 audio/control → 写能力查询
//!   `0A 01 00 00 03 03`。
//! - 控制消息（byte0）：0x0B 能力（version=b1b2、codecs、frameSize=b5b6，
//!   0=120；codec 0x02=16kHz）；0x07 就绪（二代固件可能不发，0x0B 确认即可视为就绪）；0x08 遥控器请求开麦（按住语音键
//!   时遥控器主动发起）；0x04 流开始（b1=interaction、b2=codec、b3=会话 ID）；
//!   0x0A 同步（predictor=i16BE(b4,b5)、stepIndex=b6，丢弃半帧后重置解码器）；
//!   0x00 流结束（松开）。
//! - 命令（写到 AB5E0002）：开麦 version≥0x0100 为 `0C 00`，否则 `0C 00 codec`；
//!   关麦 version≥0x0100 为 `0D <sid>`，否则 `0D`。写特征支持
//!   writeWithoutResponse 时优先用之。
//! - 音频通道是纯 ADPCM 字节流，按 frameSize 累积成帧（120 字节 = 240 样本
//!   = 15ms@16kHz）；仅接受 16kHz（codec 0x02）。
//! - 流边界：只解码收到 0x04 之后的音频；0x00 流结束后的迟到音频丢弃。
//! - 链路生命周期与「语音翻页」开关解耦：有标识缓存时启动建链，否则由 HID
//!   连接触发；开关关闭也不拆链，语音键随时可临时收音。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Mutex;

/// 日志 target。
pub(crate) const TARGET: &str = "remote-voice";
use crate::atvv_core::{
    consume_audio, mic_close_command, mic_open_command, parse_capabilities, parse_stream_start,
    parse_sync, retry_delay, ImaAdpcmDecoder, VoiceLink, AUDIO_UUID, CONTROL_UUID,
    GET_CAPABILITIES, SERVICE_UUID, TRANSMIT_UUID,
};

// ---- 生命周期管理（上层入口，进程级静态） ----

/// 进程级状态：不进 tauri State（避免与泛型 Runtime 纠缠），
/// lib.rs setup 时 `init(app)` 注入 Wry 句柄一次。
pub(crate) struct RemoteVoiceStatic {
    app: Option<tauri::AppHandle<tauri::Wry>>,
    active: AtomicBool,
    /// ATVV 链路是否就绪（voice_turner 据此切换监听形态）。
    ready: AtomicBool,
    /// PTT 识别监听器登记的音频入口；None 时音频被丢弃。
    audio_tx: Mutex<Option<Sender<Vec<i16>>>>,
}

static VOICE: Mutex<RemoteVoiceStatic> = Mutex::new(RemoteVoiceStatic {
    app: None,
    active: AtomicBool::new(false),
    ready: AtomicBool::new(false),
    audio_tx: Mutex::new(None),
});

/// lib.rs setup（macOS）调用：注入应用句柄。
pub fn init(app: tauri::AppHandle<tauri::Wry>) {
    let mut voice = VOICE.lock().unwrap();
    voice.app = Some(app);
}

/// 确保 ATVV 语音链路启动（幂等）。
///
/// 触发点与「语音翻页」全局开关无关：遥控器经 HID 连接即建链，
/// 之后按住语音键就能临时收音；开关开启时也提前建链，不依赖输入监控权限。
pub fn ensure_started() {
    let app = {
        let voice = VOICE.lock().unwrap();
        let was = voice.active.swap(true, Ordering::SeqCst);
        match voice.app.clone() {
            Some(app) if !was => Some(app),
            _ => None,
        }
    };
    if let Some(app) = app {
        let _ = app.run_on_main_thread(move || macos::start_link());
    }
}

/// 语音翻页开关变化：开→确保建链；关→保留链路（语音键仍可临时收音）。
pub fn sync_master_switch(enabled: bool) {
    if enabled {
        ensure_started();
    }
}

/// 启动时调用：仅当曾发现过遥控器（有标识缓存）才提前建链。
/// 首次使用由 HID 连接触发建链，进入配对模式后 HID 断开但链路保留，
/// 仍能扫到广播；没有遥控器的用户不会在启动时无意义地持续扫描。
#[cfg(target_os = "macos")]
pub fn ensure_started_if_known() {
    if macos::has_cached_identifier() {
        ensure_started();
    }
}

/// HID 层在遥控器连接时调用：确保链路已启动，并解除失联退避。
#[cfg(target_os = "macos")]
pub fn on_remote_connected() {
    ensure_started();
    macos::wake();
}

/// ATVV 链路是否就绪。
pub fn is_ready() -> bool {
    VOICE.lock().unwrap().ready.load(Ordering::SeqCst)
}

/// PTT 监听器登记/摘除音频入口。
pub fn set_audio_tx(sender: Option<Sender<Vec<i16>>>) {
    let voice = VOICE.lock().unwrap();
    let guard = voice.audio_tx.lock();
    if let Ok(mut tx) = guard {
        *tx = sender;
    }
}

/// 就绪状态变化后通知 voice_turner 重选监听形态。
pub(crate) fn set_ready_and_notify(ready: bool) {
    {
        let voice = VOICE.lock().unwrap();
        voice.ready.store(ready, Ordering::SeqCst);
    }
    notify_availability();
}

fn notify_availability() {
    let app = VOICE.lock().unwrap().app.clone();
    if let Some(app) = app {
        crate::voice_turner::remote_availability_changed(&app);
    }
}

/// 解码样本送 PTT 监听器（CoreBluetooth 回调线程调用）。
fn deliver_samples(samples: Vec<i16>) {
    let voice = VOICE.lock().unwrap();
    let guard = voice.audio_tx.lock();
    if let Ok(tx) = guard {
        if let Some(sender) = tx.as_ref() {
            let _ = sender.send(samples);
        }
    }
}

/// 是否应继续链路循环（重试检索前的活性检查）。
fn is_active() -> bool {
    VOICE.lock().unwrap().active.load(Ordering::SeqCst)
}

/// 解码样本 → AVAudioPCMBuffer（PTT 识别监听器调用；macOS）。
#[cfg(target_os = "macos")]
pub fn pcm_buffer_for(samples: &[i16]) -> Option<objc2::rc::Retained<objc2_avf_audio::AVAudioPCMBuffer>> {
    unsafe { macos::samples_to_pcm_buffer(samples) }
}

// ---- macOS CoreBluetooth 实现 ----

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, MainThreadMarker, MainThreadOnly};
    use objc2_avf_audio::{AVAudioFormat, AVAudioPCMBuffer};
    use objc2_core_bluetooth::{
        CBCentralManager, CBCentralManagerDelegate, CBCharacteristic,
        CBManagerState, CBPeripheral, CBPeripheralDelegate, CBService, CBUUID,
    };
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSError, NSNumber, NSString, NSUUID};
    use std::sync::atomic::{AtomicBool, AtomicU32};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use tauri::Manager;

    // ---- 链路状态（仅主队列线程触碰；静态存储需 Send/Sync 声明） ----

    struct LinkState {
        /// CoreBluetooth 的 delegate 是 weak 属性：必须由我们持有，否则
        /// 委托对象立刻释放，所有回调静默丢失。
        delegate: Mutex<Option<SendRetained<AtvvDelegate>>>,
        central: Mutex<Option<SendRetained<CBCentralManager>>>,
        /// 是否正在扫描（避免每 5 秒的检索重试叠加扫描）。
        scanning: AtomicBool,
        /// 缓存标识直连失败过：本轮改为扫描，避免对失效标识死循环重连。
        cached_failed: AtomicBool,
        /// 连接请求已发出、尚未收到 didConnect/didFail 的回调。
        connecting: AtomicBool,
        /// 已确认遥控器固件不提供语音服务：本次运行内不再重试。
        unsupported: AtomicBool,
        /// 连续查找/连接失败次数（成功连接或发现后清零）。
        retry_attempts: AtomicU32,
        /// 退避到上限后暂停扫描，等 HID 重连唤醒。
        suspended: AtomicBool,
        peripheral: Mutex<Option<SendRetained<CBPeripheral>>>,
        transmit: Mutex<Option<SendRetained<CBCharacteristic>>>,
        audio_subscribed: AtomicBool,
        control_subscribed: AtomicBool,
        capabilities_requested: AtomicBool,
        link: Mutex<VoiceLink>,
    }

    /// 跨线程持有的 ObjC 对象包装：CoreBluetooth 对象仅主队列线程触碰
    /// （回调与我们的写入都在主线程），Send/Sync 由该不变量保证。
    struct SendRetained<T>(Retained<T>);
    unsafe impl<T> Send for SendRetained<T> {}
    unsafe impl<T> Sync for SendRetained<T> {}

    static LINK: OnceLock<LinkState> = OnceLock::new();

    fn link() -> &'static LinkState {
        LINK.get_or_init(|| LinkState {
            delegate: Mutex::new(None),
            central: Mutex::new(None),
            scanning: AtomicBool::new(false),
            cached_failed: AtomicBool::new(false),
            connecting: AtomicBool::new(false),
            unsupported: AtomicBool::new(false),
            retry_attempts: AtomicU32::new(0),
            suspended: AtomicBool::new(false),
            peripheral: Mutex::new(None),
            transmit: Mutex::new(None),
            audio_subscribed: AtomicBool::new(false),
            control_subscribed: AtomicBool::new(false),
            capabilities_requested: AtomicBool::new(false),
            link: Mutex::new(VoiceLink::new()),
        })
    }

    /// 遥控器 CoreBluetooth 标识的缓存文件（每台机器不同，随应用数据目录）。
    fn identifier_cache_path() -> Option<std::path::PathBuf> {
        let app = VOICE.lock().ok()?.app.clone()?;
        let dir = app.path().app_data_dir().ok()?;
        Some(dir.join("remote-voice-peripheral"))
    }

    pub(crate) fn has_cached_identifier() -> bool {
        load_cached_identifier().is_some()
    }

    fn load_cached_identifier() -> Option<String> {
        let raw = std::fs::read_to_string(identifier_cache_path()?).ok()?;
        let value = raw.trim();
        (!value.is_empty()).then(|| value.to_string())
    }

    fn save_cached_identifier(identifier: &str) {
        let Some(path) = identifier_cache_path() else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if std::fs::write(&path, identifier).is_ok() {
            log::info!(target: TARGET, "已缓存遥控器标识，后续启动直连");
        }
    }

    // ---- 委托类：静态定义，方法只访问进程级状态 ----

    define_class!(
        // SAFETY:
        // - 超类 NSObject 无子类化要求。
        // - 本类型不实现 Drop。
        // - CBCentralManager 委托回调在主队列：MainThreadOnly。
        #[unsafe(super(objc2::runtime::NSObject))]
        #[name = "AtReaderAtvvDelegate"]
        #[thread_kind = MainThreadOnly]
        struct AtvvDelegate;

        unsafe impl CBCentralManagerDelegate for AtvvDelegate {
            #[unsafe(method(centralManagerDidUpdateState:))]
            fn central_did_update_state(&self, central: &CBCentralManager) {
                let state: CBManagerState = unsafe { msg_send![central, state] };
                if state == CBManagerState::PoweredOn {
                    log::info!(target: TARGET, "蓝牙已就绪，检索遥控器（ATVV）");
                    retrieve_peripherals();
                } else {
                    // 0=未知 1=重置中 2=不支持 3=未授权 4=已关闭
                    log::warn!(
                        target: TARGET,
                        "蓝牙不可用 state={}（3=未授权，需在 系统设置 → 隐私与安全性 → 蓝牙 中允许）",
                        state.0
                    );
                }
            }

            #[unsafe(method(centralManager:didConnectPeripheral:))]
            fn central_did_connect(&self, _central: &CBCentralManager, peripheral: &CBPeripheral) {
                log::info!(target: TARGET, "遥控器已连接（ATVV）");
                link().connecting.store(false, Ordering::SeqCst);
                link().retry_attempts.store(0, Ordering::SeqCst);
                link().suspended.store(false, Ordering::SeqCst);
                let raw: *mut CBPeripheral = unsafe { msg_send![peripheral, retain] };
                let Some(retained) = (unsafe { Retained::from_raw(raw) }) else {
                    return;
                };
                *link().peripheral.lock().unwrap() = Some(SendRetained(retained.clone()));
                link().cached_failed.store(false, Ordering::SeqCst);
                link().audio_subscribed.store(false, Ordering::SeqCst);
                link().control_subscribed.store(false, Ordering::SeqCst);
                link().capabilities_requested.store(false, Ordering::SeqCst);
                unsafe {
                    if let Some(delegate) = retained_delegate() {
                        retained.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
                    }
                    retained.discoverServices(None);
                }
            }

            #[unsafe(method(centralManager:didDisconnectPeripheral:error:))]
            fn central_did_disconnect(
                &self,
                _central: &CBCentralManager,
                _peripheral: &CBPeripheral,
                _error: *mut NSError,
            ) {
                log::info!(target: TARGET, "遥控器已断开（ATVV），3 秒后重连");
                handle_disconnect();
            }

            #[unsafe(method(centralManager:didFailToConnectPeripheral:error:))]
            fn central_did_fail_to_connect(
                &self,
                _central: &CBCentralManager,
                _peripheral: &CBPeripheral,
                _error: *mut NSError,
            ) {
                log::warn!(target: TARGET, "遥控器连接失败（ATVV），3 秒后重试");
                link().cached_failed.store(true, Ordering::SeqCst);
                link().connecting.store(false, Ordering::SeqCst);
                handle_disconnect();
            }

            #[unsafe(method(centralManager:didDiscoverPeripheral:advertisementData:RSSI:))]
            fn central_did_discover(
                &self,
                _central: &CBCentralManager,
                peripheral: &CBPeripheral,
                advertisement_data: &NSDictionary<NSString, AnyObject>,
                _rssi: &NSNumber,
            ) {
                let name = unsafe { peripheral.name() }
                    .map(|value| value.to_string())
                    .unwrap_or_default();
                let identifier = unsafe { peripheral.identifier().UUIDString() }.to_string();
                let advertised = advertisement_data
                    .objectForKey(&NSString::from_str("kCBAdvDataServiceUUIDs"))
                .and_then(|value| {
                    value.downcast_ref::<NSArray>().map(|list| {
                        list.to_vec()
                            .into_iter()
                            .filter_map(|element| {
                                element
                                    .downcast_ref::<CBUUID>()
                                    .map(|uuid| unsafe { uuid.UUIDString() }.to_string())
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .unwrap_or_default();
                // 配对模式下广播名为「小米蓝牙语音遥控器」；参考固件的广播名
                // 是 MI RC。两者都不是时再用 ATVV 服务 UUID 兜底。
                let is_target = name.contains("小米") && name.contains("遥控器")
                    || name.to_uppercase().contains("MI RC")
                    || advertised
                        .iter()
                        .any(|uuid| uuid.eq_ignore_ascii_case(SERVICE_UUID));
                if !is_target || !link().scanning.swap(false, Ordering::SeqCst) {
                    return;
                }
                save_cached_identifier(&identifier);
                link().cached_failed.store(false, Ordering::SeqCst);
                link().retry_attempts.store(0, Ordering::SeqCst);
                link().suspended.store(false, Ordering::SeqCst);
                log::info!(target: TARGET, "扫描到遥控器，发起 ATVV 连接");
                let central = link()
                    .central
                    .lock()
                    .ok()
                    .and_then(|guard| guard.as_ref().map(|stored| stored.0.clone()));
                let Some(central) = central else {
                    return;
                };
                unsafe { central.stopScan() };
                begin_connect(&central, peripheral);
            }
        }

        unsafe impl CBPeripheralDelegate for AtvvDelegate {
            #[unsafe(method(peripheral:didDiscoverServices:))]
            fn peripheral_did_discover_services(
                &self,
                peripheral: &CBPeripheral,
                _error: *mut NSError,
            ) {
                let services = unsafe { peripheral.services() };
                let target = SERVICE_UUID.to_uppercase();
                let matched = services.as_ref().and_then(|list| {
                    list.to_vec()
                        .into_iter()
                        .find(|service| unsafe { service.UUID().UUIDString() }.to_string() == target)
                });
                let Some(service) = matched else {
                    // 一代遥控器在 Mac 配对下只暴露电池/设备信息/Wiced Smart，
                    // 不提供语音通道；停止重连，避免空转。
                    log::warn!(
                        target: TARGET,
                        "该遥控器不提供 ATVV 语音服务（仅支持二代 2 / 2 Pro）"
                    );
                    link().unsupported.store(true, Ordering::SeqCst);
                    return;
                };
                unsafe { peripheral.discoverCharacteristics_forService(None, &service) };
            }

            #[unsafe(method(peripheral:didDiscoverCharacteristicsForService:error:))]
            fn peripheral_did_discover_characteristics(
                &self,
                peripheral: &CBPeripheral,
                service: &CBService,
                _error: *mut NSError,
            ) {
                let mut transmit: Option<Retained<CBCharacteristic>> = None;
                let mut audio: Option<Retained<CBCharacteristic>> = None;
                let mut control: Option<Retained<CBCharacteristic>> = None;
                let characteristics = unsafe { service.characteristics() }
                    .map(|list| list.to_vec())
                    .unwrap_or_default();
                let service_uuid = unsafe { service.UUID().UUIDString() }.to_string();
                if service_uuid != SERVICE_UUID.to_uppercase() {
                    return;
                }
                for characteristic in &characteristics {
                    let uuid = unsafe { characteristic.UUID().UUIDString() }.to_string();
                    let raw: *mut CBCharacteristic = unsafe { msg_send![characteristic, retain] };
                    let retained = unsafe { Retained::from_raw(raw) };
                    match uuid.as_str() {
                        u if u == TRANSMIT_UUID.to_uppercase() => transmit = retained,
                        u if u == AUDIO_UUID.to_uppercase() => audio = retained,
                        u if u == CONTROL_UUID.to_uppercase() => control = retained,
                        _ => {}
                    }
                }
                let (Some(transmit), Some(audio), Some(control)) = (transmit, audio, control) else {
                    log::warn!(target: TARGET, "ATVV 特征不完整，蓝牙语音不可用");
                    link().unsupported.store(true, Ordering::SeqCst);
                    return;
                };
                *link().transmit.lock().unwrap() = Some(SendRetained(transmit));
                link().audio_subscribed.store(false, Ordering::SeqCst);
                link().control_subscribed.store(false, Ordering::SeqCst);
                unsafe {
                    peripheral.setNotifyValue_forCharacteristic(true, &audio);
                    peripheral.setNotifyValue_forCharacteristic(true, &control);
                }
            }

            #[unsafe(method(peripheral:didUpdateNotificationStateForCharacteristic:error:))]
            fn peripheral_did_update_notification_state(
                &self,
                _peripheral: &CBPeripheral,
                characteristic: &CBCharacteristic,
                _error: *mut NSError,
            ) {
                if !unsafe { characteristic.isNotifying() } {
                    return;
                }
                let uuid = unsafe { characteristic.UUID().UUIDString() }.to_string();
                if uuid == AUDIO_UUID.to_uppercase() {
                    link().audio_subscribed.store(true, Ordering::SeqCst);
                } else if uuid == CONTROL_UUID.to_uppercase() {
                    link().control_subscribed.store(true, Ordering::SeqCst);
                }
                if link().audio_subscribed.load(Ordering::SeqCst)
                    && link().control_subscribed.load(Ordering::SeqCst)
                    && !link().capabilities_requested.swap(true, Ordering::SeqCst)
                {
                    unsafe { write_transmit(&GET_CAPABILITIES) };
                    log::info!(target: TARGET, "已订阅 audio/control，发送能力查询");
                }
            }

            #[unsafe(method(peripheral:didUpdateValueForCharacteristic:error:))]
            fn peripheral_did_update_value(
                &self,
                _peripheral: &CBPeripheral,
                characteristic: &CBCharacteristic,
                _error: *mut NSError,
            ) {
                let Some(value) = (unsafe { characteristic.value() }) else {
                    return;
                };
                let bytes = value.to_vec();
                if bytes.is_empty() {
                    return;
                }
                let uuid = unsafe { characteristic.UUID().UUIDString() }.to_string();
                if uuid == CONTROL_UUID.to_uppercase() {
                    handle_control(&bytes);
                } else if uuid == AUDIO_UUID.to_uppercase() {
                    handle_audio(&bytes);
                }
            }
        }
    );

    unsafe impl objc2_foundation::NSObjectProtocol for AtvvDelegate {}

    fn new_delegate() -> Retained<AtvvDelegate> {
        let mtm = MainThreadMarker::new().expect("委托创建必须在主线程");
        let allocated = AtvvDelegate::alloc(mtm);
        unsafe { msg_send![allocated, init] }
    }

    fn retained_delegate() -> Option<Retained<AtvvDelegate>> {
        link()
            .delegate
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|stored| stored.0.clone()))
    }

    // ---- 链路生命周期 ----

    /// 主线程调用：创建 CBCentralManager（蓝牙 TCC 提示在此触发）。
    /// 权限说明缺失（dev 裸二进制）时创建会被 TCC 终止，前置守卫。
    pub fn start_link() {
        if link().central.lock().unwrap().is_some() {
            retrieve_peripherals();
            return;
        }
        if !has_bluetooth_usage_description() {
            log::warn!(
                target: TARGET,
                "缺少蓝牙权限说明（开发模式裸二进制？），ATVV 语音链路不启动"
            );
            return;
        }
        unsafe {
            let delegate = new_delegate();
            // delegate 是 weak 属性：存入静态状态，直到进程退出都由我们持有。
            *link().delegate.lock().unwrap() = Some(SendRetained(delegate.clone()));
            let central = CBCentralManager::initWithDelegate_queue_options(
                CBCentralManager::alloc(),
                Some(ProtocolObject::from_ref(&*delegate)),
                None,
                None,
            );
            *link().central.lock().unwrap() = Some(SendRetained(central));
        }
    }

    fn has_bluetooth_usage_description() -> bool {
        let bundle = objc2_foundation::NSBundle::mainBundle();
        // dev 裸二进制的 Info.plist 可能被内嵌、NSBundle 能读到键，但 TCC 只认
        // .app bundle；非 .app 直接按缺省处理，避免授权 API 触发 abort。
        if !bundle.bundlePath().to_string().ends_with(".app") {
            return false;
        }
        bundle
            .objectForInfoDictionaryKey(&NSString::from_str("NSBluetoothAlwaysUsageDescription"))
            .is_some()
    }

    unsafe fn write_transmit(bytes: &[u8]) {
        let lk = link();
        let peripheral = lk.peripheral.lock().ok();
        let transmit = lk.transmit.lock().ok();
        let (Some(peripheral), Some(transmit)) = (peripheral, transmit) else {
            return;
        };
        let (Some(SendRetained(peripheral)), Some(SendRetained(transmit))) =
            (peripheral.as_ref(), transmit.as_ref())
        else {
            return;
        };
        let data = NSData::with_bytes(bytes);
        let without_response = transmit
            .properties()
            .contains(objc2_core_bluetooth::CBCharacteristicProperties::WriteWithoutResponse);
        let write_type = if without_response {
            objc2_core_bluetooth::CBCharacteristicWriteType::WithoutResponse
        } else {
            objc2_core_bluetooth::CBCharacteristicWriteType::WithResponse
        };
        peripheral.writeValue_forCharacteristic_type(&data, transmit, write_type);
    }

    fn note_retry_failure() {
        let attempt = link().retry_attempts.fetch_add(1, Ordering::SeqCst) + 1;
        match retry_delay(attempt) {
            Some(delay) => schedule_retrieve(delay),
            None => {
                if !link().suspended.swap(true, Ordering::SeqCst) {
                    log::warn!(
                        target: TARGET,
                        "遥控器长时间未找到，暂停扫描；重新连接遥控器后恢复"
                    );
                }
            }
        }
    }

    /// HID 重新连接时调用：清除退避并立即再试一次。
    pub fn wake() {
        link().retry_attempts.store(0, Ordering::SeqCst);
        link().suspended.store(false, Ordering::SeqCst);
        run_on_main(retrieve_peripherals);
    }

    fn schedule_retrieve(delay: Duration) {
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            if is_active() {
                run_on_main(retrieve_peripherals);
            }
        });
    }

    /// 发起 ATVV 连接并持有 peripheral 直到回调；超时未连上就取消重试
    /// （系统只把遥控器当 HID 连着时，首次连接请求可能一直挂起）。
    fn begin_connect(central: &CBCentralManager, peripheral: &CBPeripheral) {
        if link().connecting.swap(true, Ordering::SeqCst) {
            return;
        }
        let raw: *mut CBPeripheral = unsafe { msg_send![peripheral, retain] };
        let Some(retained) = (unsafe { Retained::from_raw(raw) }) else {
            link().connecting.store(false, Ordering::SeqCst);
            return;
        };
        *link().peripheral.lock().unwrap() = Some(SendRetained(retained.clone()));
        unsafe { central.connectPeripheral_options(&retained, None) };
        schedule_connect_timeout(Duration::from_secs(8));
    }

    fn schedule_connect_timeout(delay: Duration) {
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            if is_active() {
                run_on_main(connect_timed_out);
            }
        });
    }

    fn connect_timed_out() {
        if !link().connecting.swap(false, Ordering::SeqCst) {
            return;
        }
        let peripheral = link()
            .peripheral
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|stored| stored.0.clone()));
        let central = link()
            .central
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|stored| stored.0.clone()));
        if let (Some(peripheral), Some(central)) = (peripheral, central) {
            unsafe { central.cancelPeripheralConnection(&peripheral) };
        }
        note_retry_failure();
    }

    fn schedule_stop_scan(delay: Duration) {
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            if is_active() {
                run_on_main(stop_scan_if_no_match);
            }
        });
    }

    /// 扫描窗口结束仍未匹配：停扫并延迟重试（设备可能切到了别的广播状态）。
    fn stop_scan_if_no_match() {
        if !link().scanning.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Ok(guard) = link().central.lock() {
            if let Some(SendRetained(central)) = guard.as_ref() {
                unsafe { central.stopScan() };
            }
        }
        note_retry_failure();
    }

    fn run_on_main(work: fn()) {
        let app = VOICE.lock().unwrap().app.clone();
        if let Some(app) = app {
            let _ = app.run_on_main_thread(move || work());
        }
    }

    // ---- 控制与音频处理（主队列线程） ----

    fn handle_control(bytes: &[u8]) {
        let mut lk = link().link.lock().unwrap();
        match bytes[0] {
            0x0B => {
                let Some(caps) = parse_capabilities(bytes) else {
                    log::warn!(target: TARGET, "ATVV 能力响应解析失败：{bytes:02X?}");
                    return;
                };
                if !caps.supports_16k() {
                    log::warn!(target: TARGET, "遥控器仅支持 8kHz，语音链路不可用");
                    return;
                }
                lk.capabilities = caps;
                // 二代固件实测只发 0x0B、不保证发 0x07；能力确认后即可解析流。
                lk.ready = true;
                drop(lk);
                log::info!(
                    target: TARGET,
                    "ATVV 能力确认 version={:#06x} frame={}",
                    caps.version,
                    caps.frame_size
                );
                set_ready_and_notify(true);
            }
            0x07 => {
                lk.ready = true;
                drop(lk);
                log::info!(target: TARGET, "ATVV 就绪（0x07）");
                set_ready_and_notify(true);
            }
            0x08 => {
                if lk.ready && !lk.streaming {
                    let cmd = mic_open_command(
                        lk.capabilities.version,
                        lk.capabilities.selected_codec,
                    );
                    unsafe { write_transmit(&cmd) };
                    log::info!(target: TARGET, "遥控器请求开麦，已应答");
                }
            }
            0x04 => {
                let Some(start) = parse_stream_start(bytes) else {
                    return;
                };
                if start.codec != 0x02 {
                    log::warn!(target: TARGET, "流开始但 codec 非 16kHz：{}", start.codec);
                    return;
                }
                lk.session_id = start.session_id;
                lk.streaming = true;
                lk.audio_buffer.clear();
                lk.pending_sync = None;
                lk.decoder = ImaAdpcmDecoder::new();
                log::info!(target: TARGET, "ATVV 流开始 session={}", start.session_id);
            }
            0x0A => {
                if let Some((predictor, step)) = parse_sync(bytes) {
                    if !lk.audio_buffer.is_empty() {
                        log::info!(
                            target: TARGET,
                            "同步包丢弃半帧 {} 字节",
                            lk.audio_buffer.len()
                        );
                        lk.audio_buffer.clear();
                    }
                    lk.pending_sync = Some((predictor, step));
                }
            }
            0x00 => {
                if lk.streaming {
                    lk.streaming = false;
                    lk.audio_buffer.clear();
                    lk.pending_sync = None;
                    let cmd = mic_close_command(lk.capabilities.version, lk.session_id);
                    unsafe { write_transmit(&cmd) };
                    log::info!(target: TARGET, "ATVV 流结束 session={}", lk.session_id);
                }
            }
            _ => {}
        }
    }

    fn handle_audio(bytes: &[u8]) {
        let samples = {
            let mut lk = link().link.lock().unwrap();
            consume_audio(&mut lk, bytes)
        };
        if !samples.is_empty() {
            deliver_samples(samples);
        }
    }

    fn handle_disconnect() {
        let lk = link();
        lk.connecting.store(false, Ordering::SeqCst);
        *lk.peripheral.lock().unwrap() = None;
        *lk.transmit.lock().unwrap() = None;
        lk.audio_subscribed.store(false, Ordering::SeqCst);
        lk.control_subscribed.store(false, Ordering::SeqCst);
        lk.capabilities_requested.store(false, Ordering::SeqCst);
        if let Ok(mut lk) = lk.link.lock() {
            lk.streaming = false;
            lk.ready = false;
            lk.audio_buffer.clear();
        }
        set_ready_and_notify(false);
        note_retry_failure();
    }

    /// 主线程调用：检索系统已连接的遥控器并发起 ATVV 连接。
    pub fn retrieve_peripherals() {
        let central_guard = link().central.lock().ok();
        let central_ref: Option<&CBCentralManager> = match central_guard
            .as_ref()
            .and_then(|guard| guard.as_ref())
        {
            Some(SendRetained(central)) => Some(central),
            None => None,
        };
        let Some(central) = central_ref else {
            return;
        };
        if link().connecting.load(Ordering::SeqCst)
            || link().unsupported.load(Ordering::SeqCst)
            || link().suspended.load(Ordering::SeqCst)
        {
            return;
        }
        // 已发现的遥控器按缓存标识直连：系统把它当 HID 连着时不再广播，
        // 扫描永远找不到，只有标识直连能复用同一条 BLE 链路。
        if !link().cached_failed.load(Ordering::SeqCst) {
            if let Some(cached) = load_cached_identifier() {
                unsafe {
                    if let Some(uuid) = NSUUID::initWithUUIDString(
                        NSUUID::alloc(),
                        &NSString::from_str(&cached),
                    ) {
                        let identifiers = NSArray::from_retained_slice(&[uuid]);
                        let known = central.retrievePeripheralsWithIdentifiers(&identifiers);
                        if let Some(peripheral) = known.to_vec().into_iter().next() {
                            log::info!(target: TARGET, "按缓存标识连接遥控器（ATVV）");
                            begin_connect(central, &peripheral);
                            return;
                        }
                    }
                }
            }
        }
        unsafe {
            // 系统已连外设按「HID + 电池 + ATVV」种子服务查询，再按名称
            // 过滤：只查 HID 服务时 macOS 不返回 HID 设备，电池服务可用。
            let seed = [
                CBUUID::UUIDWithString(&NSString::from_str("1812")),
                CBUUID::UUIDWithString(&NSString::from_str("180F")),
                CBUUID::UUIDWithString(&NSString::from_str(SERVICE_UUID)),
            ];
            let services = NSArray::from_retained_slice(&seed);
            let peripherals = central.retrieveConnectedPeripheralsWithServices(&services);
            let remote = peripherals.to_vec().into_iter().find(|peripheral| {
                let name = peripheral
                    .name()
                    .map(|value| value.to_string())
                    .unwrap_or_default();
                let upper = name.to_uppercase();
                (name.contains("小米") && name.contains("遥控器"))
                    || upper.contains("MI RC")
                    || upper.contains("XIAOMI BLUETOOTH REMOTE")
            });
            if let Some(peripheral) = remote {
                log::info!(target: TARGET, "发现已连接的遥控器，发起 ATVV 连接");
                begin_connect(central, &peripheral);
                return;
            }
            // 首轮（或缓存失效）：扫描广播，匹配到后缓存标识再连接。
            if link().scanning.swap(true, Ordering::SeqCst) {
                return;
            }
            log::info!(target: TARGET, "未找到遥控器（ATVV），开始扫描广播");
            central.scanForPeripheralsWithServices_options(None, None);
            schedule_stop_scan(Duration::from_secs(8));
        }
    }

    /// 把解码样本装成 AVAudioPCMBuffer（16kHz 单声道 Float32）。
    /// PTT 识别监听器调用。
    pub unsafe fn samples_to_pcm_buffer(samples: &[i16]) -> Option<Retained<AVAudioPCMBuffer>> {
        unsafe {
            let format = AVAudioFormat::initStandardFormatWithSampleRate_channels(
                AVAudioFormat::alloc(),
                16_000.0,
                1,
            )?;
            let frames = samples.len() as u32;
            let buffer = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
                AVAudioPCMBuffer::alloc(),
                &format,
                frames,
            )?;
            let channel_data = buffer.floatChannelData();
            if channel_data.is_null() {
                return None;
            }
            let ptr = (*channel_data).as_ptr();
            if ptr.is_null() {
                return None;
            }
            for (i, sample) in samples.iter().enumerate() {
                *ptr.add(i) = f32::from(*sample) / 32768.0;
            }
            buffer.setFrameLength(frames);
            Some(buffer)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atvv_core::*;
    use std::time::Duration;

    /// 测试用 IMA 编码器：验证解码器往返自洽（编码算法与解码互逆，
    /// 按 IMA 规范的编码侧实现）。
    struct ImaEncoder {
        predictor: i32,
        step_index: usize,
    }

    impl ImaEncoder {
        fn new() -> Self {
            Self {
                predictor: 0,
                step_index: 0,
            }
        }

        fn encode_sample(&mut self, sample: i16) -> u8 {
            let step = STEP_TABLE[self.step_index];
            let diff = i32::from(sample) - self.predictor;
            let sign = diff < 0;
            let mut magnitude = diff.unsigned_abs() as i32;
            let mut code = 0u8;
            if magnitude >= step {
                code |= 4;
                magnitude -= step;
            }
            if magnitude >= step >> 1 {
                code |= 2;
                magnitude -= step >> 1;
            }
            if magnitude >= step >> 2 {
                code |= 1;
            }
            let mut delta = step >> 3;
            if code & 1 != 0 {
                delta += step >> 2;
            }
            if code & 2 != 0 {
                delta += step >> 1;
            }
            if code & 4 != 0 {
                delta += step;
            }
            self.predictor += if sign { -delta } else { delta };
            self.predictor = self.predictor.clamp(-32_768, 32_767);
            if sign {
                code |= 8;
            }
            self.step_index =
                ((self.step_index as i32 + INDEX_TABLE[(code & 7) as usize]).clamp(0, 88)) as usize;
            code
        }

        fn encode(&mut self, samples: &[i16]) -> Vec<u8> {
            let mut bytes = Vec::with_capacity(samples.len() / 2 + 1);
            let mut iter = samples.iter().peekable();
            while let Some(&s) = iter.next() {
                let first = self.encode_sample(s);
                let second = match iter.next() {
                    Some(&s2) => self.encode_sample(s2),
                    None => 0,
                };
                // 高半字节优先（与固件/解码器一致）。
                bytes.push(((first & 0x0F) << 4) | (second & 0x0F));
            }
            bytes
        }
    }

    #[test]
    fn retry_delay_backs_off_then_suspends() {
        assert_eq!(retry_delay(1), Some(Duration::from_secs(5)));
        assert_eq!(retry_delay(2), Some(Duration::from_secs(10)));
        assert_eq!(retry_delay(4), Some(Duration::from_secs(40)));
        assert_eq!(retry_delay(6), Some(Duration::from_secs(60)));
        assert_eq!(retry_delay(7), None);
    }

    #[test]
    fn adpcm_roundtrip_recovers_speech_like_signal() {
        // 平滑正弦波（模拟语音包络），ADPCM 量化误差应远小于信号幅度
        let samples: Vec<i16> = (0..480)
            .map(|i| ((i as f32 * 0.05).sin() * 8000.0) as i16)
            .collect();
        let mut encoder = ImaEncoder::new();
        let bytes = encoder.encode(&samples);
        let mut decoder = ImaAdpcmDecoder::new();
        let decoded = decoder.decode_frame(&bytes);
        assert_eq!(decoded.len(), samples.len());
        let errors: Vec<i32> = samples
            .iter()
            .zip(decoded.iter())
            .map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs())
            .collect();
        let max_err = *errors.iter().max().unwrap();
        let avg_err = errors.iter().sum::<i32>() / errors.len() as i32;
        // 贪婪编码器的阶跃过冲允许较大瞬时误差，但平均误差必须远小于幅度
        //（解码器若有 bug 会输出乱序/满幅噪声，两项断言都能抓住）。
        assert!(
            max_err < 4000,
            "ADPCM 往返最大误差 {max_err} 过大（信号幅度 8000）"
        );
        assert!(
            avg_err < 400,
            "ADPCM 往返平均误差 {avg_err} 过大（信号幅度 8000）"
        );
    }

    #[test]
    fn decoder_reset_applies_sync_state() {
        let mut decoder = ImaAdpcmDecoder::new();
        let mut encoder = ImaEncoder::new();
        let warm: Vec<i16> = (0..100).map(|i| (i * 97 % 4000 - 2000) as i16).collect();
        let _ = encoder.encode(&warm);
        let _ = decoder.decode_frame(&encoder.encode(&warm));
        decoder.reset(1234, 45);
        // 重置后首个样本由 predictor 初值与首个 nibble 决定
        let first = decoder.decode_frame(&[0x00]);
        assert!((first[0] as i32 - 1234).abs() < 200);
    }

    #[test]
    fn capabilities_parsing() {
        // version 0x0100，codecs=0x02（16kHz），frame=120
        let bytes = [0x0B, 0x01, 0x00, 0x02, 0x03, 0x00, 0x78];
        let caps = parse_capabilities(&bytes).unwrap();
        assert_eq!(caps.version, 0x0100);
        assert_eq!(caps.selected_codec, 0x02);
        assert_eq!(caps.frame_size, 120);
        assert!(caps.supports_16k());
        // 8kHz 不支持
        let bytes = [0x0B, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00];
        assert!(!parse_capabilities(&bytes).unwrap().supports_16k());
        // 帧长 0 回落 120
        assert_eq!(parse_capabilities(&bytes).unwrap().frame_size, 120);
        // 头不对
        assert!(parse_capabilities(&[0x0C, 1, 0, 2, 3, 0, 120]).is_none());
    }

    #[test]
    fn control_messages() {
        assert_eq!(mic_open_command(0x0100, 0x02), vec![0x0C, 0x00]);
        assert_eq!(mic_open_command(0x00FF, 0x02), vec![0x0C, 0x00, 0x02]);
        assert_eq!(mic_close_command(0x0100, 7), vec![0x0D, 7]);
        assert_eq!(mic_close_command(0x00FF, 7), vec![0x0D]);
        let start = parse_stream_start(&[0x04, 0x03, 0x02, 0x09]).unwrap();
        assert_eq!(start.codec, 0x02);
        assert_eq!(start.session_id, 9);
        let (predictor, step) = parse_sync(&[0x0A, 0, 0, 0, 0x12, 0x34, 45]).unwrap();
        assert_eq!(predictor, 0x1234);
        assert_eq!(step, 45);
    }

    #[test]
    fn frame_splitting_keeps_remainder() {
        let mut pending = Vec::new();
        let frames = split_frames(&mut pending, &[0xAA; 250], 120);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].len(), 120);
        assert_eq!(pending.len(), 10);
        let frames = split_frames(&mut pending, &[0xBB; 100], 120);
        assert_eq!(frames.len(), 0);
        assert_eq!(pending.len(), 110);
        let frames = split_frames(&mut pending, &[0xBB; 10], 120);
        assert_eq!(frames.len(), 1);
        assert!(pending.is_empty());
    }

    #[test]
    fn consume_audio_requires_stream_start_and_decodes() {
        // 未收到 0x04 流开始：音频一律丢弃
        let mut link = VoiceLink::new();
        assert!(consume_audio(&mut link, &[0x11; 120]).is_empty());
        // 流开始后解码
        link.streaming = true;
        link.audio_buffer.clear();
        link.decoder = ImaAdpcmDecoder::new();
        let samples = consume_audio(&mut link, &[0x11; 120]);
        assert_eq!(samples.len(), 240);
        // 同步包：丢弃半帧，下一帧用同步状态解码
        let (predictor, step) = (500i16, 20u8);
        link.pending_sync = Some((predictor, step));
        link.audio_buffer.extend_from_slice(&[0x22; 60]); // 半帧
        // 半帧不解码（无完整帧），同步等待下一帧应用
        let samples = consume_audio(&mut link, &[]);
        assert!(samples.is_empty());
        // 补齐成整帧：120 字节 = 240 样本，同步状态在帧首生效
        let samples = consume_audio(&mut link, &[0x22; 60]);
        assert_eq!(samples.len(), 240);
    }
}
