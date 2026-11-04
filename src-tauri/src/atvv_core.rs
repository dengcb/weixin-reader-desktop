//! ATVV 协议与音频纯逻辑（跨平台共享）。
//!
//! 从 macOS `remote_voice.rs` 抽出：能力/流/同步解析、IMA ADPCM 解码、
//! 帧切分与流状态。macOS CoreBluetooth 与未来 Windows WinRT GATT 共用，
//! 不包含任何平台 API，可在任意宿主上单测。

use std::time::Duration;

/// ATVV 服务与特征（Android TV Voice 私有协议）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const SERVICE_UUID: &str = "AB5E0001-5A21-4F05-BC7D-AF01F617B664";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const TRANSMIT_UUID: &str = "AB5E0002-5A21-4F05-BC7D-AF01F617B664";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const AUDIO_UUID: &str = "AB5E0003-5A21-4F05-BC7D-AF01F617B664";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const CONTROL_UUID: &str = "AB5E0004-5A21-4F05-BC7D-AF01F617B664";
/// 能力查询命令（V1.0）。
pub(crate) const GET_CAPABILITIES: [u8; 6] = [0x0A, 0x01, 0x00, 0x00, 0x03, 0x03];

// ---- 纯逻辑（跨平台可单测） ----

/// 协商出的 ATVV 能力。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Capabilities {
    pub version: u16,
    /// 16kHz ADPCM 的 codec 位为 0x02。
    pub selected_codec: u8,
    pub frame_size: usize,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            version: 0x0100,
            selected_codec: 0x02,
            frame_size: 120,
        }
    }
}

impl Capabilities {
    pub fn supports_16k(&self) -> bool {
        self.selected_codec == 0x02
    }
}

/// 解析控制通道 0x0B 能力响应。
pub(crate) fn parse_capabilities(bytes: &[u8]) -> Option<Capabilities> {
    if bytes.len() < 7 || bytes[0] != 0x0B {
        return None;
    }
    let version = (u16::from(bytes[1]) << 8) | u16::from(bytes[2]);
    let codecs = if version >= 0x0100 {
        if bytes[3] == 0 && bytes.len() >= 9 && bytes[4] & 0x03 != 0 {
            bytes[4]
        } else {
            bytes[3]
        }
    } else {
        bytes[4]
    };
    let frame_size = (usize::from(bytes[5]) << 8) | usize::from(bytes[6]);
    Some(Capabilities {
        version,
        selected_codec: if codecs & 0x02 != 0 { 0x02 } else { 0x01 },
        frame_size: if frame_size == 0 { 120 } else { frame_size },
    })
}

/// 开麦命令。
pub(crate) fn mic_open_command(version: u16, codec: u8) -> Vec<u8> {
    if version >= 0x0100 {
        vec![0x0C, 0x00]
    } else {
        vec![0x0C, 0x00, codec]
    }
}

/// 关麦命令。
pub(crate) fn mic_close_command(version: u16, session_id: u8) -> Vec<u8> {
    if version >= 0x0100 {
        vec![0x0D, session_id]
    } else {
        vec![0x0D]
    }
}

/// 控制通道消息（0x04 流开始）解析出的会话参数。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct StreamStart {
    pub codec: u8,
    pub session_id: u8,
}

/// 解析 0x04：b2=codec、b3=会话 ID（长度不足时回退默认）。
pub(crate) fn parse_stream_start(bytes: &[u8]) -> Option<StreamStart> {
    if bytes.first() != Some(&0x04) {
        return None;
    }
    Some(StreamStart {
        codec: bytes.get(2).copied().unwrap_or(0x02),
        session_id: bytes.get(3).copied().unwrap_or(0),
    })
}

/// 解析 0x0A 同步包：predictor=i16BE(b4,b5)、stepIndex=b6。
pub(crate) fn parse_sync(bytes: &[u8]) -> Option<(i16, u8)> {
    if bytes.first() != Some(&0x0A) || bytes.len() < 7 {
        return None;
    }
    let predictor = i16::from_be_bytes([bytes[4], bytes[5]]);
    Some((predictor, bytes[6]))
}

/// 遥控器失联后的重试退避：连续失败逐步拉长间隔，超过上限后暂停扫描，
/// 等 HID 重新连接事件唤醒。返回 None 表示应暂停。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn retry_delay(attempt: u32) -> Option<Duration> {
    match attempt {
        0 | 1 => Some(Duration::from_secs(5)),
        2 => Some(Duration::from_secs(10)),
        3 => Some(Duration::from_secs(20)),
        4 => Some(Duration::from_secs(40)),
        5 | 6 => Some(Duration::from_secs(60)),
        _ => None,
    }
}

/// IMA/DVI ADPCM 解码器（公开 IMA 算法；二代普通版固件高半字节优先）。
#[derive(Clone, Debug)]
pub(crate) struct ImaAdpcmDecoder {
    predictor: i32,
    step_index: usize,
}

pub(crate) const STEP_TABLE: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408,
    449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
    9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];
pub(crate) const INDEX_TABLE: [i32; 8] = [-1, -1, -1, -1, 2, 4, 6, 8];

impl ImaAdpcmDecoder {
    pub fn new() -> Self {
        Self {
            predictor: 0,
            step_index: 0,
        }
    }

    /// 用同步包给定的状态重置（0x0A 之后、下一完整帧解码前调用）。
    pub fn reset(&mut self, predictor: i16, step_index: u8) {
        self.predictor = i32::from(predictor);
        self.step_index = Self::clamp_step(step_index as usize);
    }

    fn clamp_step(step: usize) -> usize {
        step.min(88)
    }

    /// 有符号更新步长索引：0 + (-1) 不能先转 usize 再 clamp（会回绕成巨大值）。
    fn step_after(current: usize, delta: i32) -> usize {
        (current as i32 + delta).clamp(0, 88) as usize
    }

    fn decode_nibble(&mut self, nibble: u8) -> i16 {
        let step = STEP_TABLE[self.step_index];
        let mut diff = step >> 3;
        if nibble & 1 != 0 {
            diff += step >> 2;
        }
        if nibble & 2 != 0 {
            diff += step >> 1;
        }
        if nibble & 4 != 0 {
            diff += step;
        }
        self.predictor += if nibble & 8 != 0 { -diff } else { diff };
        self.predictor = self.predictor.clamp(-32_768, 32_767);
        self.step_index = Self::step_after(self.step_index, INDEX_TABLE[(nibble & 7) as usize]);
        self.predictor as i16
    }

    /// 解码一帧：高半字节优先（二代普通版真机验证；2 Pro/RC003 参考实现相同；
    /// ARN9 固件为低半字节优先，当前未做型号自适应）。
    pub fn decode_frame(&mut self, frame: &[u8]) -> Vec<i16> {
        let mut samples = Vec::with_capacity(frame.len() * 2);
        for byte in frame {
            samples.push(self.decode_nibble(byte >> 4));
            samples.push(self.decode_nibble(byte & 0x0F));
        }
        samples
    }
}

impl Default for ImaAdpcmDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// 三点平滑（a + 2b + c) >> 2：参考实现的生产后处理，抑制 ADPCM 高频毛刺。
pub(crate) fn smooth(input: &[i16]) -> Vec<i16> {
    if input.len() < 3 {
        return input.to_vec();
    }
    let mut out = input.to_vec();
    for i in 1..input.len() - 1 {
        out[i] = ((i32::from(input[i - 1]) + 2 * i32::from(input[i]) + i32::from(input[i + 1]))
            >> 2) as i16;
    }
    out
}

/// 音频字节流 → frame_size 帧切分，保留残余。
pub(crate) fn split_frames(
    pending: &mut Vec<u8>,
    incoming: &[u8],
    frame_size: usize,
) -> Vec<Vec<u8>> {
    if frame_size == 0 {
        return Vec::new();
    }
    pending.extend_from_slice(incoming);
    let mut frames = Vec::new();
    while pending.len() >= frame_size {
        let frame: Vec<u8> = pending.drain(..frame_size).collect();
        frames.push(frame);
    }
    frames
}

// ---- 会话状态（CoreBluetooth 回调读写；纯字段便于推演） ----

pub(crate) struct VoiceLink {
    pub ready: bool,
    pub streaming: bool,
    pub session_id: u8,
    pub capabilities: Capabilities,
    pub pending_sync: Option<(i16, u8)>,
    pub audio_buffer: Vec<u8>,
    pub decoder: ImaAdpcmDecoder,
}

impl VoiceLink {
    pub fn new() -> Self {
        Self {
            ready: false,
            streaming: false,
            session_id: 0,
            capabilities: Capabilities::default(),
            pending_sync: None,
            audio_buffer: Vec::new(),
            decoder: ImaAdpcmDecoder::new(),
        }
    }
}

/// 处理一包音频字节：竞态守卫 + 帧切分 + 同步应用 + 解码 + 平滑。
/// 返回应送识别器的样本（可能为空）。
pub(crate) fn consume_audio(link: &mut VoiceLink, data: &[u8]) -> Vec<i16> {
    if !link.streaming {
        // 未收到 0x04 流开始（或已结束）的音频一律丢弃：避免上一会话的
        // 解码器状态污染新会话，帧边界也不会错位。
        return Vec::new();
    }
    let frames = split_frames(&mut link.audio_buffer, data, link.capabilities.frame_size);
    let mut samples = Vec::new();
    for frame in frames {
        if let Some((predictor, step)) = link.pending_sync.take() {
            link.decoder.reset(predictor, step);
        }
        samples.extend(smooth(&link.decoder.decode_frame(&frame)));
    }
    samples
}


/// 续期命令（Windows 参考实现每 2.5s 发送一次，固件免费窗口约 5–6s）。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn mic_extend_command(version: u16, session_id: u8) -> Option<Vec<u8>> {
    (version >= 0x0100).then(|| vec![0x0E, session_id])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mic_extend_only_for_v10() {
        assert_eq!(mic_extend_command(0x0100, 3), Some(vec![0x0E, 3]));
        assert_eq!(mic_extend_command(0x0099, 3), None);
    }
}
