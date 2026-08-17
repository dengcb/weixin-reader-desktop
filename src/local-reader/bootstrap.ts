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
window.addEventListener('error', (event) => {
  report('runtime_error', event.message || '未知脚本错误');
});
window.addEventListener('unhandledrejection', (event) => {
  report('unhandled_rejection', String(event.reason ?? '未知 Promise 错误'));
});

const script = document.createElement('script');
script.src = '/local-reader.js';
script.onload = () => report('main_script_loaded');
script.onerror = () => report('main_script_error');
document.body.append(script);
