#![allow(dead_code)]
//! Windows 遥控器语音（实验性骨架，**接线层未接**）。
//!
//! 机制参考 `remote-mic-app-windows/crates/sayall-windows/src/ble.rs` 与
//! `audio.rs`（GPL-3.0，只学机制、独立实现）：
//! - WinRT `BluetoothLEDevice` + GATT 直连 ATVV（与 macOS 同一组服务）；
//! - 解码后的 PCM 通过 WASAPI 渲染到 VB-CABLE（`CABLE Input`）；
//! - 识别仍复用 `voice_turner` 的 Windows SpeechRecognizer，但该识别器只读
//!   默认麦克风，因此 PTT 期间需要把默认录音设备切到 `CABLE Output`。
//!
//! **未接的最后一层**：`switch_default_recording_device`（IPolicyConfig COM）
//! 与 `start_ptt` 的调用接线。在接好之前：
//! - 模块不会启动任何 GATT/WASAPI 会话；
//! - 用户侧行为与现在完全一致（Windows 语音仍走默认麦克风）；
//! - 期待有 Windows 真机的开发者按本文件底部清单补完并提交 PR。
//!
//! 真机坑位（来自参考实现注释）：
//! - 流式会话中每 2.5s 发送 MIC_EXTEND(0x0E)，固件免费音频窗口约 5–6s；
//! - 静默 8s 强制收尾，防「按住说话」粘死；
//! - WinRT 异步 GATT 调用必须设界，半死链路可能永不返回。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::atvv_core::{
    consume_audio, mic_close_command, mic_extend_command, mic_open_command, parse_capabilities,
    parse_stream_start, parse_sync, Capabilities, ImaAdpcmDecoder, VoiceLink, GET_CAPABILITIES,
};
use wasapi::{
    AudioClient, AudioRenderClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
};
use windows::core::GUID;
use windows::Devices::Bluetooth::BluetoothLEDevice;
use windows::Devices::Bluetooth::GenericAttributeProfile::{
    GattCharacteristic, GattClientCharacteristicConfigurationDescriptorValue, GattCommunicationStatus,
    GattDeviceService, GattValueChangedEventArgs,
};
use windows::Devices::Enumeration::DeviceInformation;
use windows::Foundation::TypedEventHandler;
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Storage::Streams::DataReader;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

const TARGET: &str = "remote-voice";
const SERVICE_GUID: GUID = GUID::from_u128(0xab5e00015a214f05bc7daf01f617b664);
const TRANSMIT_GUID: GUID = GUID::from_u128(0xab5e00025a214f05bc7daf01f617b664);
const AUDIO_GUID: GUID = GUID::from_u128(0xab5e00035a214f05bc7daf01f617b664);
const CONTROL_GUID: GUID = GUID::from_u128(0xab5e00045a214f05bc7daf01f617b664);

/// 固件免费音频窗口约 5–6s，2.5s 续期留足余量。
const MIC_EXTEND_INTERVAL: Duration = Duration::from_millis(2500);
/// 静默这么久仍未收到音频就强制收尾，防「按住说话」粘死。
const IDLE_TIMEOUT: Duration = Duration::from_secs(8);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug)]
pub(crate) enum WindowsVoiceError {
    /// 接线层尚未实现（默认录音设备切换 + PTT 调用）。
    WiringPending,
    WinRt(String),
    Audio(String),
    NoCable,
}

impl std::fmt::Display for WindowsVoiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WiringPending => write!(f, "Windows 语音接线层未实现"),
            Self::WinRt(error) => write!(f, "WinRT: {error}"),
            Self::Audio(error) => write!(f, "WASAPI: {error}"),
            Self::NoCable => write!(f, "未找到 VB-CABLE 的 CABLE Input 渲染端点"),
        }
    }
}

enum RemoteEvent {
    Control(Vec<u8>),
    Audio(Vec<u8>),
}

/// 唯一的公开入口。接线层完成前固定返回 WiringPending，不建立任何链路。
pub(crate) fn start_ptt(_app: &tauri::AppHandle<tauri::Wry>, _stop: Arc<AtomicBool>) -> Result<(), WindowsVoiceError> {
    Err(WindowsVoiceError::WiringPending)
}

/// 已配对 BLE 设备里按名称找小米遥控器。
fn find_remote() -> Result<BluetoothLEDevice, WindowsVoiceError> {
    let selector = BluetoothLEDevice::GetDeviceSelectorFromPairingState(true)
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
    let devices = wait(DeviceInformation::FindAllAsyncAqsFilter(&selector).map_err(|error| {
        WindowsVoiceError::WinRt(error.to_string())
    })?)?;
    let count = devices
        .Size()
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
    for index in 0..count {
        let info = devices
            .GetAt(index)
            .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
        let name = info
            .Name()
            .map(|value| value.to_string())
            .unwrap_or_default();
        let upper = name.to_uppercase();
        let is_remote = (name.contains("小米") && name.contains("遥控"))
            || upper.contains("MI RC")
            || upper.contains("XIAOMI BLUETOOTH REMOTE")
            || upper.contains("ARN9");
        if !is_remote {
            continue;
        }
        let id = info
            .Id()
            .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
        return wait(
            BluetoothLEDevice::FromIdAsync(&id)
                .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?,
        );
    }
    Err(WindowsVoiceError::WinRt(
        "未找到已配对的二代小米遥控器".to_string(),
    ))
}

/// 连接 ATVV 并运行一次语音会话（松开/停止时退出）。
fn run_session(device: &BluetoothLEDevice, stop: &AtomicBool) -> Result<(), WindowsVoiceError> {
    // TODO(接线层): 会话开始时调用 switch_default_recording_device(true)，
    // 结束时恢复 false；当前唯一入口 start_ptt 直接返回 WiringPending。
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let service = find_service(device)?;
    let (transmit, audio, control) = find_characteristics(&service)?;
    let (tx, rx) = mpsc::channel();
    let _control_token = subscribe(&control, ControlKind::Control, tx.clone())?;
    let _audio_token = subscribe(&audio, ControlKind::Audio, tx)?;
    write_characteristic(&transmit, &GET_CAPABILITIES)?;
    let mut sink = CableSink::open()?;
    run_loop(&transmit, &rx, &mut sink, stop)
}

fn find_service(device: &BluetoothLEDevice) -> Result<GattDeviceService, WindowsVoiceError> {
    let result = wait_bounded(
        device
            .GetGattServicesAsync()
            .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?,
        Duration::from_secs(5),
    )?;
    let status = result
        .Status()
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
    if status != GattCommunicationStatus::Success {
        return Err(WindowsVoiceError::WinRt(format!(
            "GATT 服务枚举失败：{status:?}"
        )));
    }
    let services = result
        .Services()
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
    let count = services
        .Size()
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
    for index in 0..count {
        let service = services
            .GetAt(index)
            .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
        if service.Uuid().ok() == Some(SERVICE_GUID) {
            return Ok(service);
        }
    }
    Err(WindowsVoiceError::WinRt("未发现 ATVV 服务".to_string()))
}

fn find_characteristics(
    service: &GattDeviceService,
) -> Result<(GattCharacteristic, GattCharacteristic, GattCharacteristic), WindowsVoiceError> {
    let result = wait_bounded(
        service
            .GetCharacteristicsAsync()
            .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?,
        Duration::from_secs(5),
    )?;
    let status = result
        .Status()
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
    if status != GattCommunicationStatus::Success {
        return Err(WindowsVoiceError::WinRt(format!(
            "GATT 特征枚举失败：{status:?}"
        )));
    }
    let list = result
        .Characteristics()
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
    let mut transmit = None;
    let mut audio = None;
    let mut control = None;
    let count = list
        .Size()
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
    for index in 0..count {
        let characteristic = list
            .GetAt(index)
            .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
        match characteristic.Uuid().ok() {
            Some(uuid) if uuid == TRANSMIT_GUID => transmit = Some(characteristic),
            Some(uuid) if uuid == AUDIO_GUID => audio = Some(characteristic),
            Some(uuid) if uuid == CONTROL_GUID => control = Some(characteristic),
            _ => {}
        }
    }
    match (transmit, audio, control) {
        (Some(transmit), Some(audio), Some(control)) => Ok((transmit, audio, control)),
        _ => Err(WindowsVoiceError::WinRt("ATVV 特征不完整".to_string())),
    }
}

#[derive(Clone, Copy)]
enum ControlKind {
    Audio,
    Control,
}

fn subscribe(
    characteristic: &GattCharacteristic,
    kind: ControlKind,
    tx: Sender<RemoteEvent>,
) -> Result<i64, WindowsVoiceError> {
    let handler = TypedEventHandler::<GattCharacteristic, GattValueChangedEventArgs>::new(
        move |_sender, args| {
            let args = &*args;
            let Some(args) = args else {
                return Ok(());
            };
            let buffer = args.CharacteristicValue()?;
            let length = buffer.Length()? as usize;
            if length == 0 {
                return Ok(());
            }
            let reader = DataReader::FromBuffer(&buffer)?;
            let mut bytes = vec![0u8; length];
            reader.ReadBytes(&mut bytes)?;
            let event = match kind {
                ControlKind::Audio => RemoteEvent::Audio(bytes),
                ControlKind::Control => RemoteEvent::Control(bytes),
            };
            let _ = tx.send(event);
            Ok(())
        },
    );
    let token = characteristic
        .ValueChanged(&handler)
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
    wait_bounded(
        characteristic.WriteClientCharacteristicConfigurationDescriptorAsync(
            GattClientCharacteristicConfigurationDescriptorValue::Notify,
        )
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?,
        Duration::from_secs(3),
    )?;
    Ok(token)
}

fn write_characteristic(
    characteristic: &GattCharacteristic,
    bytes: &[u8],
) -> Result<(), WindowsVoiceError> {
    let buffer = CryptographicBuffer::CreateFromByteArray(bytes)
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?;
    wait_bounded(
        characteristic
            .WriteValueWithResultAsync(&buffer)
            .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))?,
        Duration::from_secs(3),
    )?;
    Ok(())
}

fn run_loop(
    transmit: &GattCharacteristic,
    rx: &Receiver<RemoteEvent>,
    sink: &mut CableSink,
    stop: &AtomicBool,
) -> Result<(), WindowsVoiceError> {
    let mut link = VoiceLink::new();
    let mut last_audio = Instant::now();
    let mut last_extend = Instant::now();
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match rx.recv_timeout(POLL_INTERVAL) {
            Ok(RemoteEvent::Control(bytes)) => {
                if bytes.first() == Some(&0x04) {
                    last_audio = Instant::now();
                    last_extend = Instant::now();
                }
                handle_control(&mut link, &bytes, transmit)?;
            }
            Ok(RemoteEvent::Audio(bytes)) => {
                last_audio = Instant::now();
                let samples = consume_audio(&mut link, &bytes);
                if !samples.is_empty() {
                    sink.push(&samples)?;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if link.streaming {
            if last_audio.elapsed() >= IDLE_TIMEOUT {
                log::warn!(target: TARGET, "Windows 语音静默超时，强制收尾");
                link.streaming = false;
                let _ = write_characteristic(
                    transmit,
                    &mic_close_command(link.capabilities.version, link.session_id),
                );
            } else if last_extend.elapsed() >= MIC_EXTEND_INTERVAL {
                last_extend = Instant::now();
                if let Some(command) =
                    mic_extend_command(link.capabilities.version, link.session_id)
                {
                    let _ = write_characteristic(transmit, &command);
                }
            }
        }
    }
    sink.stop();
    Ok(())
}

fn handle_control(
    link: &mut VoiceLink,
    bytes: &[u8],
    transmit: &GattCharacteristic,
) -> Result<(), WindowsVoiceError> {
    match bytes.first().copied() {
        Some(0x0B) => {
            if let Some(caps) = parse_capabilities(bytes) {
                apply_capabilities(link, caps);
            }
        }
        Some(0x07) => link.ready = true,
        Some(0x08) => {
            if link.ready && !link.streaming {
                let command =
                    mic_open_command(link.capabilities.version, link.capabilities.selected_codec);
                write_characteristic(transmit, &command)?;
            }
        }
        Some(0x04) => {
            if let Some(start) = parse_stream_start(bytes) {
                if start.codec != 0x02 {
                    log::warn!(target: TARGET, "Windows 语音流 codec 非 16kHz：{}", start.codec);
                    return Ok(());
                }
                link.session_id = start.session_id;
                link.streaming = true;
                link.audio_buffer.clear();
                link.pending_sync = None;
                link.decoder = ImaAdpcmDecoder::new();
            }
        }
        Some(0x0A) => {
            if let Some((predictor, step)) = parse_sync(bytes) {
                link.pending_sync = Some((predictor, step));
            }
        }
        Some(0x00) => {
            if link.streaming {
                link.streaming = false;
                link.audio_buffer.clear();
                link.pending_sync = None;
                let command =
                    mic_close_command(link.capabilities.version, link.session_id);
                let _ = write_characteristic(transmit, &command);
            }
        }
        _ => {}
    }
    Ok(())
}

fn apply_capabilities(link: &mut VoiceLink, caps: Capabilities) {
    link.capabilities = caps;
    // 二代固件实测只发 0x0B，不发 0x07；能力确认即可解析流。
    link.ready = caps.supports_16k();
    if !link.ready {
        log::warn!(target: TARGET, "Windows 遥控器仅支持 8kHz，语音不可用");
    }
}

/// WASAPI 渲染到 VB-CABLE 的 `CABLE Input`（16 kHz 单声道 s16）。
struct CableSink {
    client: AudioClient,
    render: AudioRenderClient,
    started: bool,
}

impl CableSink {
    fn open() -> Result<Self, WindowsVoiceError> {
        if wasapi::initialize_mta().is_err() {
            return Err(WindowsVoiceError::Audio("WASAPI COM 初始化失败".to_string()));
        }
        let enumerator = DeviceEnumerator::new()
            .map_err(|error| WindowsVoiceError::Audio(error.to_string()))?;
        let devices = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(|error| WindowsVoiceError::Audio(error.to_string()))?;
        for device in &devices {
            let device = device.map_err(|error| WindowsVoiceError::Audio(error.to_string()))?;
            let name = device
                .get_friendlyname()
                .map_err(|error| WindowsVoiceError::Audio(error.to_string()))?;
            let lower = name.to_lowercase();
            if !(lower.contains("cable input") || lower.contains("cable in")) {
                continue;
            }
            let mut client = device
                .get_iaudioclient()
                .map_err(|error| WindowsVoiceError::Audio(error.to_string()))?;
            // 冷端点直接 Initialize 会拿到 0x8889000A；先读一次混音格式预热。
            let _ = client.get_mixformat();
            let (period, _) = client
                .get_device_period()
                .map_err(|error| WindowsVoiceError::Audio(error.to_string()))?;
            let format = WaveFormat::new(16, 16, &SampleType::Int, 16_000, 1, None);
            client
                .initialize_client(
                    &format,
                    &Direction::Render,
                    &StreamMode::PollingShared {
                        autoconvert: true,
                        buffer_duration_hns: period,
                    },
                )
                .map_err(|error| WindowsVoiceError::Audio(error.to_string()))?;
            let render = client
                .get_audiorenderclient()
                .map_err(|error| WindowsVoiceError::Audio(error.to_string()))?;
            return Ok(Self {
                client,
                render,
                started: false,
            });
        }
        Err(WindowsVoiceError::NoCable)
    }

    fn push(&mut self, samples: &[i16]) -> Result<(), WindowsVoiceError> {
        let available = self
            .client
            .get_available_space_in_frames()
            .map_err(|error| WindowsVoiceError::Audio(error.to_string()))? as usize;
        let frames = available.min(samples.len());
        if frames == 0 {
            return Ok(());
        }
        let mut bytes = Vec::with_capacity(frames * 2);
        for sample in &samples[..frames] {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        self.render
            .write_to_device(frames, &bytes, None)
            .map_err(|error| WindowsVoiceError::Audio(error.to_string()))?;
        if !self.started {
            self.client
                .start_stream()
                .map_err(|error| WindowsVoiceError::Audio(error.to_string()))?;
            self.started = true;
        }
        Ok(())
    }

    fn stop(&mut self) {
        if self.started {
            let _ = self.client.stop_stream();
            let _ = self.client.reset_stream();
            self.started = false;
        }
    }
}

/// 接线层（未实现）：PTT 期间把默认录音设备切到 `CABLE Output`，结束后恢复。
/// 参考实现只把 PCM 播到 CABLE、由用户输入法监听；本项目要自己识别，
/// 必须切换默认录音设备，建议用 `IPolicyConfig::SetDefaultEndpoint` 实现。
fn switch_default_recording_device(_to_cable: bool) -> Result<(), WindowsVoiceError> {
    Err(WindowsVoiceError::WiringPending)
}

fn wait<T>(operation: windows_future::IAsyncOperation<T>) -> Result<T, WindowsVoiceError>
where
    T: windows::core::RuntimeType + 'static,
{
    tauri::async_runtime::block_on(async move { operation.await })
        .map_err(|error| WindowsVoiceError::WinRt(error.to_string()))
}

/// 有界等待：半死链路下 GATT 查询可能永不返回，超时后 Cancel 让调用方收尾。
fn wait_bounded<T>(
    operation: windows_future::IAsyncOperation<T>,
    timeout: Duration,
) -> Result<T, WindowsVoiceError>
where
    T: windows::core::RuntimeType + 'static,
{
    let watchdog = operation.clone();
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        let _ = watchdog.Cancel();
    });
    wait(operation)
}
