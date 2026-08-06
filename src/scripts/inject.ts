import { AppRuntime } from './core/app_runtime';
import { log } from './core/logger';
import { invoke } from './core/tauri';

async function main(): Promise<void> {
  // 主窗口也会承载本地默认页；阅读运行时只应注入网络站点。
  if (!['http:', 'https:'].includes(window.location.protocol)) return;

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
  // Windows 菜单栏隐藏：Ctrl+M（macOS 不生效）
  // 摸鱼键（Cmd/Ctrl + `）已由 Rust 端全局热键注册，窗口隐藏后也能响应
  //
  // Windows 专属"瞒天过海"快捷键方案：
  // Windows + WebView2 下 muda 菜单 accelerator 全面失效（Edge 引擎在菜单消息
  // 循环之前消费了所有 Ctrl 系列键盘事件，如 Ctrl+P 打印、Ctrl+O 打开文件、
  // Ctrl+=/-/0 缩放）。菜单里照常显示快捷键提示文字，实际触发走前端 keydown
  // 监听，在 capture 阶段 preventDefault 拦住 WebView2 默认行为，再调
  // simulate_menu_click 复用菜单点击逻辑。macOS 完全不受影响，不进入此分支。
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
    '8': 'hide_cursor',
    'o': 'hide_toolbar',
    'p': 'hide_navbar',
  };

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;

    // 书店快捷键 Ctrl+1~7（跨平台）
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
      const action = windowsShortcutMap[normalizedKey];
      if (action) {
        e.preventDefault();
        e.stopImmediatePropagation();
        invoke('simulate_menu_click', { action }).catch(() => {});
      }
    }
  }, true); // capture 阶段拦截，比 WebView2 默认行为更早

  const runtime = new AppRuntime();
  try {
    await runtime.initialize();
    (window as any).atreaderRuntime = runtime;
    log.info(`[Inject] Initialized for ${window.location.hostname}`);
  } catch (error) {
    runtime.destroy();
    log.error('[Inject] Critical initialization error', error);
  }
}

void main();
