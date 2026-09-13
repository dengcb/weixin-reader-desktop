import { AppRuntime } from './core/app_runtime';
import { attachKeyboardToSameOriginIframes } from './core/iframe_keyboard';
import { log } from './core/logger';
import { invoke } from './core/tauri';



async function main(): Promise<void> {
  // 主窗口也会承载本地默认页；阅读运行时只应注入网络站点。
  if (!['http:', 'https:'].includes(window.location.protocol)) return;
  // Windows 的自定义协议映射为 http://atreader.localhost，仍属于可信本地页，
  // 必须由 local-reader 自行启动 local runtime，不能误走远程插件注入。
  if (window.location.hostname === 'atreader.localhost') return;

  // Windows/WebView2 会向子框架注入初始化脚本；跨域 OAuth iframe 必须跳过。
  if (window.self !== window.top) {
    try {
      void (window.top as Window).location.href;
    } catch {
      return;
    }
  }

  if ((window as any).wxrd_injected || (window as any).atreader_injected) return;
  (window as any).wxrd_injected = true;
  (window as any).atreader_injected = true;

  // 书店快捷键：Cmd/Ctrl + 1~7 按序号切换书店
  // Windows 菜单栏隐藏：Ctrl+H（macOS 不生效——Cmd+H 被系统保留）
  // 摸鱼键（Cmd/Ctrl + `）已由 Rust 端全局热键注册，窗口隐藏后也能响应
  //
  // Windows 专属"瞒天过海"快捷键方案：
  // Windows + WebView2 下 muda 菜单 accelerator 全面失效（Edge 引擎在菜单消息
  // 循环之前消费了所有 Ctrl 系列键盘事件，如 Ctrl+P 打印、Ctrl+O 浏览器打开文件、
  // Ctrl+=/-/0 缩放）。菜单里照常显示快捷键提示文字，实际触发走前端 keydown
  // 监听，在 capture 阶段 preventDefault 拦住 WebView2 默认行为，再调
  // simulate_menu_click 复用菜单点击逻辑。macOS 完全不受影响，不进入此分支。
  //
  // 焦点可达性：微信读书正文渲染在同源 iframe 内，用户划选正文后键盘焦点停留在
  // 该 frame，keydown 不冒泡出 iframe，顶层 handler 收不到——Ctrl+H/F11 等
  // 因此「完全无反应」（用户真机反馈）。此 handler 需同时挂到主文档与全部
  // 同源 iframe 文档（复用 remote_manager 已有的转发工具）。
  const isWindows = navigator.userAgent.includes('Windows');

  // Ctrl+键 → 菜单动作映射表（仅 Windows 生效，macOS 走原生菜单 accelerator）
  const windowsShortcutMap: Record<string, string> = {
    ',': 'settings',
    'r': 'refresh',
    '[': 'back',
    ']': 'forward',
    'i': 'auto_flip',
    '=': 'zoom_in',
    '-': 'zoom_out',
    '0': 'zoom_reset',
    '9': 'reader_wide',
    'o': 'hide_toolbar',
    'p': 'hide_navbar',
  };

  const shortcutHandler = (e: KeyboardEvent) => {
    // Windows F11 全屏：WebView2 同样会拦截单功能键，菜单 accelerator 不生效。
    // 走前端 keydown 模拟 simulate_menu_click，与 Ctrl 快捷键同一套障眼法。
    if (isWindows && e.key === 'F11') {
      e.preventDefault();
      e.stopImmediatePropagation();
      invoke('simulate_menu_click', { action: 'toggle_fullscreen' }).catch(() => {});
      return;
    }

    if (!(e.metaKey || e.ctrlKey)) return;

    // 书店快捷键 Cmd/Ctrl+1~7（跨平台）
    if (e.key >= '1' && e.key <= '7') {
      e.preventDefault();
      invoke('switch_bookstore_by_index', { index: parseInt(e.key, 10) }).catch(() => {});
      return;
    }

    // Windows 菜单栏隐藏 Ctrl+H：走前端 keydown（菜单 accelerator 绑了会双重触发，
    // 不绑 accelerator 在 Windows 上又完全不响应，只能前端处理）。
    // 菜单文字用 \t 手写 "Ctrl+H" 提示，accelerator 参数为 None。
    if (e.ctrlKey && e.key.toLowerCase() === 'h' && isWindows) {
      e.preventDefault();
      invoke('toggle_menu_bar').catch(() => {});
      return;
    }

    // Windows 专属"瞒天过海"快捷键：拦截 WebView2 默认行为，模拟菜单点击
    if (isWindows && e.ctrlKey) {
      const rawKey = e.key.toLowerCase();
      const codeMap: Record<string, string> = {
        'BracketLeft': '[',
        'BracketRight': ']',
        'Comma': ',',
      };
      const normalizedKey = rawKey || (codeMap[e.code] ?? '');
      const action = normalizedKey === 'o' && e.shiftKey
        ? 'open_local_book'
        : windowsShortcutMap[normalizedKey];
      if (action) {
        e.preventDefault();
        e.stopImmediatePropagation();
        invoke('simulate_menu_click', { action }).catch(() => {});
      }
    }
  };

  window.addEventListener('keydown', shortcutHandler, true); // capture 阶段拦截，比 WebView2 默认行为更早
  // 同源 iframe 转发：正文 frame 内按键同样可达（跨域 frame 无法转发，见工具注释）。
  // 转发器内部的 observe 已改为 DOMContentLoaded 后再挂（见 iframe_keyboard 顶部
  // 注释），但任何挂载异常都不允许炸穿 main()：快捷键转发属增强能力，失败
  // 不应连累 AppRuntime/样式面板（dev.3 真机事故的教训——曾让整条注入链死亡）。
  let detachIframeForwarding: (() => void) | null = null;
  try {
    detachIframeForwarding = attachKeyboardToSameOriginIframes(shortcutHandler);
  } catch (error) {
    log.error('[Inject] iframe 键盘转发挂载失败（快捷键仍作用于主文档）', error);
  }

  // 全屏 hover 唤出菜单栏（Windows：全屏为 borderless，OS 无「顶边唤出」行为，
  // 由应用自建命中区）。命中带取顶层视口 clientY ≤ 2（125%/150% DPI 下 CSS
  // 像素换算后仍有 1~3px 捕获带）。两层可达性（与快捷键同构的断点）：
  // - 事件来源：指针位于正文 iframe 上方时 mousemove 派发进 frame 文档，
  //   主 window 收不到——edgeHandler 同样经同源 iframe 转发挂载；
  // - 坐标语义：iframe 转发附加 __atreaderTopClientY（frame 偏移换算后的
  //   顶层视口坐标），主文档事件回退原 clientY。
  // 触发后 500ms 节流：避免驻留命中带期间 60Hz 连发 IPC。
  // 全屏碰顶交互与整窗主题联动由后续提交链引入；本提交仅含注入时序修复。

  const runtime = new AppRuntime();
  try {
    await runtime.initialize();
    (window as any).atreaderRuntime = runtime;
    log.info(`[Inject] Initialized for ${window.location.hostname}`);
  } catch (error) {
    detachIframeForwarding?.();
    runtime.destroy();
    log.error('[Inject] Critical initialization error', error);
  }
}

void main();
