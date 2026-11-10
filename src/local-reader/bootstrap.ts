type DiagnosticStage = 'bootstrap_started' | 'main_script_loaded' | 'main_script_error' | 'runtime_error' | 'unhandled_rejection';

const report = (stage: DiagnosticStage, detail?: string): void => {
  const query = new URLSearchParams({ stage });
  if (detail) query.set('detail', detail.slice(0, 240));
  void fetch(`/local-reader-diagnostic?${query.toString()}`).catch(() => {});
  try {
    const message = `[LocalReaderBootstrap] ${stage}${detail ? ` ${detail.slice(0, 240)}` : ''}`;
    window.__TAURI__?.core?.invoke('log_to_file', { message }).catch(() => {});
  } catch {
    // The diagnostic protocol is the primary path while Tauri IPC is starting.
  }
};

report('bootstrap_started');
// 排障关键：只报 message 拿不到调用方，堆栈一并截断上报（240 字符内）
const describeError = (value: unknown, fallback: string): string => {
  const stack = (value as { stack?: string } | null)?.stack;
  const message = value instanceof Error ? value.message : String(value ?? fallback);
  return stack ? `${message}\n${stack}` : message;
};
window.addEventListener('error', (event) => {
  const source = event.error ?? event.message;
  report('runtime_error', describeError(source, '未知脚本错误'));
});
window.addEventListener('unhandledrejection', (event) => {
  report('unhandled_rejection', describeError(event.reason, '未知 Promise 错误'));
});

const script = document.createElement('script');
script.src = '/local-reader.js';
script.onload = () => report('main_script_loaded');
script.onerror = () => report('main_script_error');
document.body.append(script);
