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

  // 书店快捷键：Cmd/Ctrl + 1~9 按序号切换书店
  // 摸鱼键（Cmd/Ctrl + `）已由 Rust 端全局热键注册，窗口隐藏后也能响应
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      invoke('switch_bookstore_by_index', { index: parseInt(e.key, 10) }).catch(() => {});
    }
  });

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
