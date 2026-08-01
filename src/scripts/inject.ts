import { AppRuntime } from './core/app_runtime';
import { log } from './core/logger';

async function main(): Promise<void> {
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
