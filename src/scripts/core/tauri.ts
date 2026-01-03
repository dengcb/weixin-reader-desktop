
import { log } from './logger';

declare global {
  interface Window {
    __TAURI__: {
      core: {
        invoke: <T = any>(cmd: string, args?: Record<string, any>) => Promise<T>;
      };
      event: {
        listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
      };
      webviewWindow: {
        WebviewWindow: any;
      };
    };
  }
}

// 核心逻辑：动态获取 Tauri API
// 不要静态捕获 window.__TAURI__，因为脚本执行时机可能早于 Tauri 注入
export const invoke = <T = any>(cmd: string, args?: Record<string, any>): Promise<T> => {
    if (window.__TAURI__) {
        return window.__TAURI__.core.invoke(cmd, args);
    }
    log.warn(`[Tauri] Invoke '${cmd}' failed: API not found`);
    return Promise.resolve({} as T);
};

export const listen = <T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> => {
    if (window.__TAURI__) {
        return window.__TAURI__.event.listen(event, handler);
    }
    log.warn(`[Tauri] Listen '${event}' failed: API not found`);
    return Promise.resolve(() => {});
};

export const createWebviewWindow = (label: string, options: any) => {
    if (window.__TAURI__) {
        return new window.__TAURI__.webviewWindow.WebviewWindow(label, options);
    }
    log.warn(`[Tauri] createWebviewWindow failed: API not found`);
    return null;
};

export const waitForTauri = (): Promise<void> => {
    return new Promise((resolve) => {
        if (window.__TAURI__) {
            resolve();
            return;
        }

        const check = setInterval(() => {
            if (window.__TAURI__) {
                clearInterval(check);
                resolve();
            }
        }, 10);

        // 超时保底 (例如 2秒)，避免死等
        setTimeout(() => {
            clearInterval(check);
            resolve();
        }, 2000);
    });
};

// Wait for Tauri to be actually ready to handle IPC calls
// This tests IPC by calling a simple command
export const waitForTauriReady = async (): Promise<void> => {
    // First wait for __TAURI__ object
    await waitForTauri();

    // Then test if IPC is actually working by trying to get app name
    // Wait up to 5 seconds for IPC to be ready (increased from 3s)
    // Homepage needs more time for IPC to switch from custom protocol to postMessage
    const maxAttempts = 100; // 100 * 50ms = 5 seconds
    const delay = 50;

    for (let i = 0; i < maxAttempts; i++) {
        try {
            await invoke('get_app_name');
            log.debug(`[Tauri] IPC ready after ${i * delay}ms`);
            return; // Success!
        } catch (e) {
            // IPC not ready yet, wait and retry
            if (i < maxAttempts - 1) {
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    // If we get here, IPC is still not ready, but we'll continue anyway
    log.warn(`[Tauri] IPC not ready after ${maxAttempts * delay}ms, continuing anyway`);
};

// Log to file utility
export const logToFile = (message: string) => {
    if (window.__TAURI__) {
        invoke('log_to_file', { message })
            .catch(() => {}); // Silently fail if logging fails
    } else {
        log.debug(message); // Fallback to console if Tauri not ready
    }
};
