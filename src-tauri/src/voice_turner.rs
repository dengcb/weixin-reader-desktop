//! 语音翻页（issue #25，macOS 第一期）：设置开启后后台监听麦克风，
//! 系统设备端语音识别（Speech.framework，语音不出本机）的中间结果
//! 一包含翻页词，立即调用现有「下一页」菜单动作。
//!
//! 结构要点（PoC `src/bin/voice_poc.rs` 实证结论）：
//! - 识别回调投递到发起线程的 runloop：监听线程必须跑 NSRunLoop，
//!   不能用 sleep 循环（任务会永远停在 starting）。
//! - 触发走 `menu::handle_menu_action("reader_next_page")`，天然继承
//!   阅读页门禁与主窗口聚焦检查；模拟键盘输入的方案已由 issue 作者排除。
//! - 启停由设置写入路径驱动（`sync_from_settings`），无轮询。

use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

/// 语音触发冷却：对齐用户键盘/遥控翻页的自然节奏，
/// 有意短于 issue #25 原案的 5 秒。如需调整改这一个常量。
const TRIGGER_COOLDOWN: Duration = Duration::from_secs(2);

/// 翻页词默认值；空值或纯空白保存时回落。
pub const DEFAULT_PHRASE: &str = "翻页";

/// 触发判定器（纯逻辑，便于单测）。
/// - N-best 候选任一包含翻页词即触发（真机实证 best 常给同音的
///   「翻译」，「翻页」在候选列表里）；
/// - 去重完全由冷却承担：on-device 识别结果从不 finalize（真机
///   实证），无句边界可依赖，冷却窗口就是同句 partial 连环的闸门。
pub(crate) struct TriggerGate {
    phrase: String,
    last_trigger: Option<Instant>,
    cooldown: Duration,
}

impl TriggerGate {
    pub(crate) fn new(phrase: &str) -> Self {
        Self {
            phrase: phrase.to_string(),
            last_trigger: None,
            cooldown: TRIGGER_COOLDOWN,
        }
    }

    /// 热更新翻页词：仅 macOS 回调路径调用（Windows 词表编译后
    /// 不可变，改词由 sync 统一重启监听）。
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn update_phrase(&mut self, phrase: &str) {
        self.phrase = phrase.to_string();
    }

    /// 输入一次识别的全部候选文本，返回是否应当翻页。
    pub(crate) fn feed(&mut self, texts: &[String]) -> bool {
        let hit =
            !self.in_cooldown() && texts.iter().any(|text| text.contains(self.phrase.as_str()));
        if hit {
            self.last_trigger = Some(Instant::now());
        }
        hit
    }

    fn in_cooldown(&self) -> bool {
        self.last_trigger
            .is_some_and(|t| t.elapsed() < self.cooldown)
    }
}

/// 归一化翻页词：去首尾空白；空值回落默认词。
pub(crate) fn normalize_phrase(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        DEFAULT_PHRASE.to_string()
    } else {
        trimmed.to_string()
    }
}

/// 从设置文档提取（开关, 翻页词）。
fn voice_settings_from_document(settings: &Value) -> (bool, String) {
    let global = settings.get("global");
    let enabled = global
        .and_then(|g| g.get("voicePageTurn"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let phrase = global
        .and_then(|g| g.get("voicePageTurnPhrase"))
        .and_then(Value::as_str)
        .map(normalize_phrase)
        .unwrap_or_else(|| DEFAULT_PHRASE.to_string());
    (enabled, phrase)
}

struct ActiveListener {
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

/// 语音翻页监听管理状态（lib.rs setup 中 manage）。
pub struct VoiceTurnerState {
    listener: Mutex<Option<ActiveListener>>,
    phrase: Mutex<String>,
}

impl VoiceTurnerState {
    pub fn new() -> Self {
        Self {
            listener: Mutex::new(None),
            phrase: Mutex::new(DEFAULT_PHRASE.to_string()),
        }
    }
}

/// 设置写入后的统一入口：与当前状态 diff——开→启、关→停、词变→重启。
/// 所有写入路径（patch_settings / update_setting / 启动恢复）都必须经过这里，
/// 保证监听状态永远跟随设置文档（事件驱动，无轮询）。
/// 词变化统一重启监听：Windows 词表编译后不可变，macOS 虽可热更，
/// 但重启路径已随开关切换验证可靠，统一行为最简。
pub fn sync_from_settings<R: Runtime>(app: &AppHandle<R>, settings: &Value) {
    let Some(state) = app.try_state::<VoiceTurnerState>() else {
        return;
    };
    let (enabled, phrase) = voice_settings_from_document(settings);
    let previous_phrase =
        std::mem::replace(&mut *state.phrase.lock().unwrap(), phrase.clone());

    let mut listener = state.listener.lock().unwrap();
    if enabled && listener.is_some() && previous_phrase != phrase {
        let active = listener.take();
        drop(listener);
        if let Some(active) = active {
            active
                .stop
                .store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = active.thread.join();
        }
        listener = state.listener.lock().unwrap();
    }
    if !enabled {
        let active = listener.take();
        // 释放锁后再 join：监听线程的失败回滚会再次进入本函数等锁。
        drop(listener);
        if let Some(active) = active {
            active
                .stop
                .store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = active.thread.join();
        }
        return;
    }
    // 已在监听：无需动作。
    if listener.is_some() {
        return;
    }
    // 平台实现：macOS / Windows 有监听实现；其余平台防御性回滚。
    #[cfg(target_os = "macos")]
    let entry: fn(AppHandle<R>, Arc<AtomicBool>, String) = macos::listen;
    #[cfg(target_os = "windows")]
    let entry: fn(AppHandle<R>, Arc<AtomicBool>, String) = windows_impl::listen;

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let handle = app.clone();
        let thread = std::thread::Builder::new()
            .name("voice-turner".into())
            .spawn(move || {
                entry(handle, thread_stop, phrase);
            })
            .expect("spawn voice turner thread");
        *listener = Some(ActiveListener { stop, thread });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        drop(listener);
        let _ = app.get_webview_window("main").map(|win| {
            let _ = win.emit("show-toast", "语音翻页当前仅支持 macOS 与 Windows");
        });
        let _ = crate::settings::update_setting(
            app,
            "global.voicePageTurn",
            Value::Bool(false),
        );
    }
}

/// 监听线程退出时的自清理：把自己从 state 摘除。
/// 否则失败回滚路径的 sync 会尝试 join 自己所在的线程。
fn cleanup_after_listen<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<VoiceTurnerState>() {
        if let Ok(mut listener) = state.listener.lock() {
            let self_id = std::thread::current().id();
            let is_self = listener
                .as_ref()
                .is_some_and(|active| active.thread.thread().id() == self_id);
            if is_self {
                *listener = None;
            }
        }
    }
}

/// 触发翻页：回主线程执行菜单动作。
/// 真机实证（macOS）：系统语音组件可能瞬时抢窗口焦点造成误拒，
/// 实时焦点为真时 500ms 重试一次；Windows 保留同一自愈逻辑。
fn fire_page_turn<R: Runtime>(app: &AppHandle<R>) {
    let page_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(error) = crate::menu::handle_menu_action(&page_app, "reader_next_page") {
            let realtime = page_app
                .get_webview_window("main")
                .and_then(|win| win.is_focused().ok());
            log::info!(
                target: "voice-turner",
                "翻页动作被拒绝：{error}；main 实时焦点={realtime:?}"
            );
            if realtime == Some(true) {
                let retry_app = page_app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let inner_app = retry_app.clone();
                    let _ = retry_app.run_on_main_thread(move || {
                        if let Err(retry_error) =
                            crate::menu::handle_menu_action(&inner_app, "reader_next_page")
                        {
                            log::info!(target: "voice-turner", "重试仍被拒：{retry_error}");
                        }
                    });
                });
            }
        }
    });
}

#[cfg(target_os = "macos")]
mod macos {
    use super::TriggerGate;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_avf_audio::{AVAudioEngine, AVAudioPCMBuffer, AVAudioTime};
    use objc2_foundation::{NSArray, NSBundle, NSDate, NSLocale, NSRunLoop, NSString};
    use objc2_speech::{
        SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognizer,
        SFSpeechRecognizerAuthorizationStatus,
    };
    use serde_json::Value;
    use std::cell::RefCell;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager, Runtime};

    /// 新建识别会话请求：partial + 强制 on-device + 上下文提示词。
    /// contextualStrings 把翻页词直接喂给识别器（真机实证命中率极低：
 /// 123 次回调仅 3 次候选含「翻页」，ASR 偏好同音的「翻译」）。
    fn build_request(
        phrase: &str,
    ) -> Retained<SFSpeechAudioBufferRecognitionRequest> {
        let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
        unsafe {
            request.setShouldReportPartialResults(true);
            request.setRequiresOnDeviceRecognition(true);
            let hints = NSArray::from_retained_slice(&[NSString::from_str(phrase)]);
            request.setContextualStrings(hints.as_ref());
        }
        request
    }

    fn toast<R: Runtime>(app: &AppHandle<R>, text: &str) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.emit("show-toast", text);
        }
    }

    /// 启动失败统一收口：提示用户并回滚开关（回滚会再次进入 sync，幂等停止）。
    fn fail_with_rollback<R: Runtime>(app: &AppHandle<R>, message: &str) {
        toast(app, message);
        let _ = crate::settings::update_setting(app, "global.voicePageTurn", Value::Bool(false));
    }

    /// 授权流程结果：区分环境不支持与用户拒绝，提示文案不同。
    enum AuthorizationOutcome {
        Authorized,
        Denied,
        /// main bundle 缺 usage description：tauri dev 以裸二进制运行时如此，
        /// 调用授权 API 会被 TCC 直接 abort（真机实证），必须提前拒绝。
        UnsupportedEnvironment,
    }

    /// 检查 main bundle 是否携带麦克风/语音识别权限说明。
    /// 这些键由 tauri build 从 Info.plist 注入 .app；dev 裸二进制没有。
    fn has_usage_descriptions() -> bool {
        let bundle = NSBundle::mainBundle();
        let has = |key: &str| {
            bundle
                .objectForInfoDictionaryKey(&NSString::from_str(key))
                .is_some()
        };
        has("NSMicrophoneUsageDescription") && has("NSSpeechRecognitionUsageDescription")
    }

    /// 等待语音识别授权；stop 置位时提前放弃（秒级轮询，可被停止打断）。
    fn ensure_authorized(stop: &AtomicBool) -> AuthorizationOutcome {
        if !has_usage_descriptions() {
            return AuthorizationOutcome::UnsupportedEnvironment;
        }
        let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
        if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
            return AuthorizationOutcome::Authorized;
        }
        if status != SFSpeechRecognizerAuthorizationStatus::NotDetermined {
            // 已被拒绝或受限：不再弹窗打扰，交由失败收口提示。
            return AuthorizationOutcome::Denied;
        }
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |s: SFSpeechRecognizerAuthorizationStatus| {
            let _ = tx.send(s);
        });
        unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
        loop {
            if stop.load(Ordering::Relaxed) {
                return AuthorizationOutcome::Denied;
            }
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(SFSpeechRecognizerAuthorizationStatus::Authorized) => {
                    return AuthorizationOutcome::Authorized
                }
                Ok(_) => return AuthorizationOutcome::Denied,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return AuthorizationOutcome::Denied,
            }
        }
    }

    pub(super) fn listen<R: Runtime>(
        app: AppHandle<R>,
        stop: Arc<AtomicBool>,
        _phrase: String,
    ) {
        // 提示词在 listen_inner 内读当前设置；改词由 sync 统一重启监听。
        listen_inner(&app, &stop);
        super::cleanup_after_listen(&app);
    }

    fn listen_inner<R: Runtime>(app: &AppHandle<R>, stop: &Arc<AtomicBool>) {
        match ensure_authorized(stop) {
            AuthorizationOutcome::Authorized => {}
            AuthorizationOutcome::UnsupportedEnvironment => {
                fail_with_rollback(app, "语音翻页需要打包版应用，开发模式不可用");
                return;
            }
            AuthorizationOutcome::Denied => {
                if !stop.load(Ordering::Relaxed) {
                    fail_with_rollback(
                        app,
                        "语音翻页需要「语音识别」权限，请在系统设置中允许后重试",
                    );
                }
                return;
            }
        }

        let locale =
            NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &NSString::from_str("zh-CN"));
        let recognizer =
            unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale) };
        let Some(recognizer) = recognizer else {
            fail_with_rollback(app, "当前系统不支持中文语音识别，语音翻页未开启");
            return;
        };
        if !unsafe { recognizer.isAvailable() }
            || !unsafe { recognizer.supportsOnDeviceRecognition() }
        {
            // 语音不出本机：不支持设备端识别时直接拒绝，绝不回退服务器识别。
            fail_with_rollback(app, "当前系统不支持设备端语音识别，语音翻页未开启");
            return;
        }

        // 识别会话全生命周期单例：真机实证 cancel 后立即新建的会话会被
        // 系统静默哑掉（重建后零回调），识别质量靠 contextualStrings 锚定
        //（真机实证：「翻页」连续出现在 best，不再漂向同音词），不重建。
        // 提示词取启动时的设置词；改词后匹配由 gate 热更新，提示词沿用
        // 旧词仅轻微降低增益，不影响正确性。
        let request = {
            let phrase = app
                .try_state::<crate::voice_turner::VoiceTurnerState>()
                .and_then(|state| state.phrase.lock().ok().map(|guard| guard.clone()))
                .unwrap_or_else(|| crate::voice_turner::DEFAULT_PHRASE.to_string());
            build_request(&phrase)
        };

        let engine = unsafe { AVAudioEngine::new() };
        let input = unsafe { engine.inputNode() };
        let bus_format = unsafe { input.outputFormatForBus(0) };
        let gate = RefCell::new(TriggerGate::new(""));
        let request_for_tap = request.clone();

        let tap = RcBlock::new(
            move |buffer: NonNull<AVAudioPCMBuffer>, _time: NonNull<AVAudioTime>| {
                let buffer = unsafe { buffer.as_ref() };
                unsafe {
                    request_for_tap.appendAudioPCMBuffer(buffer);
                }
            },
        );
        unsafe {
            input.installTapOnBus_bufferSize_format_block(
                0,
                1024,
                Some(&bus_format),
                RcBlock::as_ptr(&tap),
            );
        }
        unsafe {
            engine.prepare();
        }
        if unsafe { engine.startAndReturnError() }.is_err() {
            fail_with_rollback(app, "麦克风不可用，语音翻页未开启");
            return;
        }

        let handler_app = app.clone();
        let handler_stop = Arc::clone(stop);
        let handler = RcBlock::new(
            move |result: *mut SFSpeechRecognitionResult,
                  _error: *mut objc2_foundation::NSError| {
                // 停止后忽略迟到回调，不排队补翻（issue 需求 9）。
                if handler_stop.load(Ordering::Relaxed) {
                    return;
                }
                let Some(result) = (unsafe { result.as_ref() }) else {
                    return;
                };
                let (best, candidates) = unsafe {
                    let transcriptions = result.transcriptions();
                    let texts: Vec<String> = transcriptions
                        .iter()
                        .map(|transcription| transcription.formattedString().to_string())
                        .collect();
                    (
                        result.bestTranscription().formattedString().to_string(),
                        texts,
                    )
                };
                // 取证日志（INFO）：一轮验收后视情况降级。
                log::info!(
                    target: "voice-turner",
                    "asr best={best:?} candidates={candidates:?}"
                );
                let mut gate = gate.borrow_mut();
                // 翻页词热更新：回调时读取最新设置词，改词无需重启监听。
                if let Some(state) =
                    handler_app.try_state::<crate::voice_turner::VoiceTurnerState>()
                {
                    if let Ok(phrase) = state.phrase.lock() {
                        gate.update_phrase(&phrase);
                    }
                }
                if gate.feed(&candidates) {
                    let realtime_focus = handler_app
                        .get_webview_window("main")
                        .and_then(|win| win.is_focused().ok());
                    log::info!(
                        target: "voice-turner",
                        "trigger fired; main realtime focus={realtime_focus:?}"
                    );
                    super::fire_page_turn(&handler_app);
                }
            },
        );
        let task =
            unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };

        log::info!(target: "voice-turner", "listening started");
        // runloop 短周期轮询 stop：回调依赖本线程 runloop 投递（PoC 实证）。
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let until = NSDate::initWithTimeIntervalSinceNow(NSDate::alloc(), 0.2);
            NSRunLoop::currentRunLoop().runUntilDate(&until);
        }
        unsafe { task.cancel() };
        unsafe { engine.stop() };
        log::info!(target: "voice-turner", "listening stopped");
    }
}

/// Windows 二期：WinRT Windows.Media.SpeechRecognition。
/// 引擎与模型系统自带（零 C++、零模型体积），音频由
/// ContinuousRecognitionSession 自采集。词表约束（ListConstraint）
/// 把识别结果限定在翻页词内，同音词歧义天然不存在。
#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{cleanup_after_listen, fire_page_turn, TriggerGate};
    use serde_json::Value;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager, Runtime};
    use windows::core::HSTRING;
    use windows::Foundation::TypedEventHandler;
    use windows::Media::SpeechRecognition::{
        SpeechContinuousRecognitionResultGeneratedEventArgs,
        SpeechContinuousRecognitionSession, SpeechRecognitionHypothesisGeneratedEventArgs,
        SpeechRecognitionListConstraint, SpeechRecognitionResultStatus, SpeechRecognizer,
    };

    fn toast<R: Runtime>(app: &AppHandle<R>, text: &str) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.emit("show-toast", text);
        }
    }

    /// 启动失败统一收口：提示用户并回滚开关（回滚会再次进入 sync，幂等停止）。
    fn fail_with_rollback<R: Runtime>(app: &AppHandle<R>, message: &str) {
        toast(app, message);
        let _ = crate::settings::update_setting(app, "global.voicePageTurn", Value::Bool(false));
    }

    pub(super) fn listen<R: Runtime>(
        app: AppHandle<R>,
        stop: Arc<AtomicBool>,
        phrase: String,
    ) {
        listen_inner(&app, &stop, &phrase);
        cleanup_after_listen(&app);
    }

    fn listen_inner<R: Runtime>(app: &AppHandle<R>, stop: &Arc<AtomicBool>, phrase: &str) {
        // 跟随系统语言创建识别器（中文系统即 zh-CN）；未安装对应
        // 语音识别语言包时创建/编译失败，按提示引导安装。
        let recognizer = match SpeechRecognizer::new() {
            Ok(recognizer) => recognizer,
            Err(_) => {
                fail_with_rollback(
                    app,
                    "未安装系统语音识别，请在 Windows 设置 → 时间和语言 → 语音 中添加后重试",
                );
                return;
            }
        };

        // 词表约束：编译后不可变，改词由 sync 统一重启监听。
        let commands =
            windows_collections::IIterable::from(vec![HSTRING::from(phrase)]);
        let Ok(constraint) = SpeechRecognitionListConstraint::Create(&commands) else {
            fail_with_rollback(app, "语音识别词表创建失败，语音翻页未开启");
            return;
        };
        if let Err(_) = recognizer.Constraints().and_then(|list| list.Append(&constraint)) {
            fail_with_rollback(app, "语音识别词表安装失败，语音翻页未开启");
            return;
        }
        let compiled = recognizer
            .CompileConstraintsAsync()
            .and_then(|op| tauri::async_runtime::block_on(async move { op.await }));
        let compiled_ok = matches!(
            compiled,
            Ok(result)
                if matches!(
                    result.Status(),
                    Ok(SpeechRecognitionResultStatus::Success)
                )
        );
        if !compiled_ok {
            fail_with_rollback(app, "语音识别初始化失败，语音翻页未开启");
            return;
        }

        let Ok(session) = recognizer.ContinuousRecognitionSession() else {
            fail_with_rollback(app, "语音识别会话创建失败，语音翻页未开启");
            return;
        };

        let gate = Arc::new(std::sync::Mutex::new(TriggerGate::new(phrase)));
        let result_app = app.clone();
        let result_stop = Arc::clone(stop);
        let result_gate = Arc::clone(&gate);
        let result_handler = TypedEventHandler::<
            SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionResultGeneratedEventArgs,
        >::new(move |_sender, args| {
            if result_stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            let args = &*args;
            let Some(args) = args else {
                return Ok(());
            };
            let text = args.Result()?.Text()?.to_string();
            log::info!(target: "voice-turner", "asr result text={text:?}");
            if result_gate.lock().unwrap().feed(&[text]) {
                log::info!(target: "voice-turner", "trigger fired");
                fire_page_turn(&result_app);
            }
            Ok(())
        });
        let Ok(result_token) = session.ResultGenerated(&result_handler) else {
            fail_with_rollback(app, "语音识别事件注册失败，语音翻页未开启");
            return;
        };

        // 中间假设（说到词尾即触发，不等整句）：事件在 recognizer 上。
        let hypothesis_app = app.clone();
        let hypothesis_stop = Arc::clone(stop);
        let hypothesis_gate = Arc::clone(&gate);
        let hypothesis_handler = TypedEventHandler::<
            SpeechRecognizer,
            SpeechRecognitionHypothesisGeneratedEventArgs,
        >::new(move |_sender, args| {
            if hypothesis_stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            let args = &*args;
            let Some(args) = args else {
                return Ok(());
            };
            let text = args.Hypothesis()?.Text()?.to_string();
            log::info!(target: "voice-turner", "asr hypothesis text={text:?}");
            if hypothesis_gate.lock().unwrap().feed(&[text]) {
                log::info!(target: "voice-turner", "trigger fired");
                fire_page_turn(&hypothesis_app);
            }
            Ok(())
        });
        let Ok(hypothesis_token) = recognizer.HypothesisGenerated(&hypothesis_handler) else {
            let _ = session.RemoveResultGenerated(result_token);
            fail_with_rollback(app, "语音识别事件注册失败，语音翻页未开启");
            return;
        };

        if session
            .StartAsync()
            .and_then(|op| tauri::async_runtime::block_on(async move { op.await }))
            .is_err()
        {
            let _ = session.RemoveResultGenerated(result_token);
            let _ = recognizer.RemoveHypothesisGenerated(hypothesis_token);
            fail_with_rollback(app, "语音识别会话启动失败，语音翻页未开启");
            return;
        }

        log::info!(target: "voice-turner", "listening started");
        // WinRT 回调在线程池分发，保活只需轮询 stop（无需 runloop）。
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        // 停止：注销事件 → 停会话；迟到回调由 stop 标志拦截。
        let _ = session.RemoveResultGenerated(result_token);
        let _ = recognizer.RemoveHypothesisGenerated(hypothesis_token);
        let _ = session
            .StopAsync()
            .and_then(|op| tauri::async_runtime::block_on(async move { op.await }));
        let _ = recognizer.Close();
        log::info!(target: "voice-turner", "listening stopped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    fn gate(phrase: &str) -> TriggerGate {
        TriggerGate::new(phrase)
    }

    fn texts(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    #[test]
    fn phrase_hit_triggers_immediately_on_partial() {
        let mut g = gate("翻页");
        assert!(!g.feed(&texts(&["翻"])));
        assert!(g.feed(&texts(&["翻页"])));
    }

    #[test]
    fn nbest_candidates_rescue_homophone_miss() {
        // 真机实证：best 常是同音的「翻译」，「翻页」在候选列表里。
        let mut g = gate("翻页");
        assert!(!g.feed(&texts(&["翻译"])));
        assert!(g.feed(&texts(&["翻译", "翻页"])));
    }

    #[test]
    fn non_matching_text_never_triggers() {
        let mut g = gate("翻页");
        assert!(!g.feed(&texts(&["你好"])));
        assert!(!g.feed(&texts(&["翻过去"])));
        assert!(!g.feed(&texts(&["页"])));
    }

    #[test]
    fn cooldown_is_the_only_dedup_window() {
        // 同句 partial 连环与快速重复都由冷却拦截；冷却结束即可再触发
        // （on-device 从不 finalize，去重不能再依赖句边界，真机实证）。
        let mut g = gate("翻页");
        assert!(g.feed(&texts(&["翻页"])));
        assert!(!g.feed(&texts(&["翻页翻页"])));
        assert!(!g.feed(&texts(&["翻页"])));
        g.last_trigger = Some(Instant::now() - TRIGGER_COOLDOWN - Duration::from_millis(100));
        assert!(g.feed(&texts(&["翻页"])));
    }

    #[test]
    fn cooldown_blocks_until_elapsed() {
        let mut g = gate("翻页");
        g.last_trigger = Some(Instant::now() - TRIGGER_COOLDOWN + Duration::from_millis(100));
        // 还差 100ms：忽略。
        assert!(!g.feed(&texts(&["翻页"])));
        g.last_trigger = Some(Instant::now() - TRIGGER_COOLDOWN - Duration::from_millis(100));
        // 已超出 100ms：放行。
        assert!(g.feed(&texts(&["翻页"])));
    }

    #[test]
    fn phrase_hot_update_replaces_old_phrase() {
        let mut g = gate("翻页");
        g.update_phrase("下一页");
        assert!(!g.feed(&texts(&["翻页"])));
        assert!(g.feed(&texts(&["下一页"])));
    }

    #[test]
    fn phrase_normalization_falls_back_on_blank() {
        assert_eq!(normalize_phrase("  下一页  "), "下一页");
        assert_eq!(normalize_phrase("   "), DEFAULT_PHRASE);
        assert_eq!(normalize_phrase(""), DEFAULT_PHRASE);
    }

    #[test]
    fn voice_settings_read_defaults_and_overrides() {
        assert_eq!(
            voice_settings_from_document(&json!({})),
            (false, DEFAULT_PHRASE.to_string())
        );
        assert_eq!(
            voice_settings_from_document(&json!({
                "global": { "voicePageTurn": true, "voicePageTurnPhrase": " 下一页 " }
            })),
            (true, "下一页".to_string())
        );
    }
}
